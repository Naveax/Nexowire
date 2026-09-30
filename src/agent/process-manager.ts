import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import * as z from 'zod';
import type { PathPolicy } from './path-policy.js';

const ShellSchema = z.enum(['pwsh', 'powershell', 'cmd', 'bash', 'sh']);

const StartSchema = z.object({
  command: z.string().min(1).max(200_000),
  shell: ShellSchema.optional(),
  cwd: z.string().max(4096).optional(),
  name: z.string().min(1).max(128).optional(),
  durable: z.boolean().default(false),
  max_buffer_bytes: z
    .number()
    .int()
    .min(65_536)
    .max(16_777_216)
    .default(4_194_304),
});

const ReadSchema = z.object({
  session_id: z.string().uuid(),
  after_seq: z.number().int().min(0).default(0),
  max_events: z.number().int().min(1).max(1000).default(200),
  wait_ms: z.number().int().min(0).max(10_000).default(0),
});

const WriteSchema = z.object({
  session_id: z.string().uuid(),
  input: z.string().max(1_048_576),
  append_newline: z.boolean().default(false),
});

const SessionSchema = z.object({ session_id: z.string().uuid() });

const PruneSchema = z.object({
  older_than_ms: z
    .number()
    .int()
    .min(0)
    .max(2_592_000_000)
    .optional(),
});

const PersistedSessionSchema = z.object({
  id: z.string().uuid(),
  name: z.string().max(128).optional(),
  pid: z.number().int().positive().nullable(),
  shell: z.string().min(1).max(64),
  cwd: z.string().max(4096).optional(),
  startedAt: z.string().datetime(),
  exitedAt: z.string().datetime().optional(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  status: z.enum(['running', 'exited', 'orphaned', 'lost']),
  durable: z.boolean().optional(),
  workerDir: z.string().max(4096).optional(),
  workerPid: z.number().int().positive().nullable().optional(),
});

const PersistedStateSchema = z.object({
  version: z.literal(1),
  sessions: z.array(PersistedSessionSchema).max(10_000),
});

export interface ProcessOutputEvent {
  seq: number;
  stream: 'stdout' | 'stderr';
  text: string;
  at: string;
}

type SessionStatus = 'running' | 'exited' | 'orphaned' | 'lost';

interface ManagedSession {
  id: string;
  name?: string;
  pid: number | null;
  command?: string;
  shell: string;
  cwd?: string;
  child?: ChildProcessWithoutNullStreams;
  startedAt: string;
  exitedAt?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  status: SessionStatus;
  recovered: boolean;
  durable: boolean;
  workerDir?: string;
  workerPid?: number | null;
  events: ProcessOutputEvent[];
  nextSeq: number;
  bufferedBytes: number;
  maxBufferBytes: number;
}

export interface ProcessManagerEvent {
  topic:
    | 'process.started'
    | 'process.output'
    | 'process.exited'
    | 'process.input';
  data: Record<string, unknown>;
}

export interface ProcessManagerOptions {
  stateFile?: string;
  maxSessions?: number;
  exitedRetentionMs?: number;
  onEvent?: (event: ProcessManagerEvent) => void;
  workerRoot?: string;
  workerEntrypoint?: string;
  workerExecArgv?: string[];
}

export class ProcessManagerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProcessManagerError';
  }
}

function hasExecutable(command: string): boolean {
  const probe = spawnSync(
    process.platform === 'win32' ? 'where.exe' : 'which',
    [command],
    { windowsHide: true, stdio: 'ignore' },
  );
  return probe.status === 0;
}

function resolveShell(
  shell: z.infer<typeof ShellSchema> | undefined,
  command: string,
): { executable: string; args: string[]; label: string } {
  if (process.platform === 'win32') {
    const selected =
      shell ?? (hasExecutable('pwsh.exe') ? 'pwsh' : 'powershell');
    if (selected === 'pwsh') {
      return {
        executable: 'pwsh.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
        label: selected,
      };
    }
    if (selected === 'powershell') {
      return {
        executable: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
        label: selected,
      };
    }
    if (selected === 'cmd') {
      return {
        executable: 'cmd.exe',
        args: ['/D', '/S', '/C', command],
        label: selected,
      };
    }
    return { executable: selected, args: ['-lc', command], label: selected };
  }

  if (shell === 'cmd' || shell === 'powershell') {
    throw new ProcessManagerError(
      'SHELL_UNAVAILABLE',
      `Shell ${shell} is unavailable on this platform.`,
    );
  }
  if (shell === 'pwsh') {
    return {
      executable: 'pwsh',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      label: shell,
    };
  }
  const selected = shell === 'sh' ? 'sh' : 'bash';
  return { executable: selected, args: ['-lc', command], label: selected };
}

const WorkerControlSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().uuid(),
  port: z.number().int().min(1).max(65_535),
  token: z.string().min(32).max(256),
  workerPid: z.number().int().positive(),
  createdAt: z.string().datetime(),
});

const WorkerStatusSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().uuid(),
  workerPid: z.number().int().positive(),
  childPid: z.number().int().positive().nullable(),
  status: z.enum(['starting', 'running', 'exited']),
  startedAt: z.string().datetime(),
  exitedAt: z.string().datetime().optional(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  nextSeq: z.number().int().min(1),
  maxBufferBytes: z.number().int().min(65_536).max(16_777_216),
});

const WorkerEventSchema = z.object({
  seq: z.number().int().min(1),
  stream: z.enum(['stdout', 'stderr']),
  text: z.string(),
  at: z.string().datetime(),
});

type WorkerControl = z.infer<typeof WorkerControlSchema>;
type WorkerStatus = z.infer<typeof WorkerStatusSchema>;

async function readJsonIfExists<T>(
  file: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  try {
    return schema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return undefined;
    }
    throw error;
  }
}

async function readWorkerEvents(
  workerDir: string,
): Promise<ProcessOutputEvent[]> {
  const file = path.join(workerDir, 'events.jsonl');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return [];
    }
    throw error;
  }

  const events: ProcessOutputEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(WorkerEventSchema.parse(JSON.parse(line)));
    } catch {
      // Ignore a partially-written trailing line and any corrupt event.
    }
  }
  return events.sort((a, b) => a.seq - b.seq);
}

async function sendWorkerControl(
  control: WorkerControl,
  payload: Record<string, unknown>,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = net.createConnection({
      host: '127.0.0.1',
      port: control.port,
    });
    let buffer = '';
    let settled = false;
    const finish = (
      error?: Error,
      result?: Record<string, unknown>,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result ?? {});
    };
    const timer = setTimeout(
      () =>
        finish(
          new ProcessManagerError(
            'PROCESS_WORKER_TIMEOUT',
            'Durable process worker did not respond in time.',
          ),
        ),
      timeoutMs,
    );

    socket.setEncoding('utf8');
    socket.once('error', (error) => finish(error));
    socket.once('connect', () => {
      socket.write(
        JSON.stringify({
          ...payload,
          token: control.token,
        }) + '\n',
      );
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const decoded = JSON.parse(
          buffer.slice(0, newline),
        ) as Record<string, unknown>;
        if (decoded.ok !== true) {
          finish(
            new ProcessManagerError(
              String(decoded.error ?? 'PROCESS_WORKER_ERROR'),
              'Durable process worker rejected the control request.',
            ),
          );
          return;
        }
        finish(undefined, decoded);
      } catch (error) {
        finish(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
  });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EPERM'
    );
  }
}

async function killPidTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        'taskkill.exe',
        ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' },
      );
      killer.once('error', () => resolve());
      killer.once('close', () => resolve());
    });
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // It already exited or cannot be signaled.
    }
  }
}

function summarize(session: ManagedSession) {
  return {
    sessionId: session.id,
    ...(session.name ? { name: session.name } : {}),
    pid: session.pid,
    ...(session.command ? { command: session.command } : {}),
    shell: session.shell,
    ...(session.cwd ? { cwd: session.cwd } : {}),
    status: session.status,
    recovered: session.recovered,
    durable: session.durable,
    reattachable:
      session.durable &&
      session.status === 'running' &&
      Boolean(session.workerPid && isPidAlive(session.workerPid)),
    interactive:
      session.status === 'running' &&
      (session.durable
        ? Boolean(session.workerPid && isPidAlive(session.workerPid))
        : session.child !== undefined && session.child.stdin.writable),
    exitCode: session.exitCode,
    signal: session.signal,
    startedAt: session.startedAt,
    ...(session.exitedAt ? { exitedAt: session.exitedAt } : {}),
    oldestSeq: session.events[0]?.seq ?? session.nextSeq,
    latestSeq: session.nextSeq - 1,
    bufferedEvents: session.events.length,
    bufferedBytes: session.bufferedBytes,
  };
}

export class ProcessManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly stateFile?: string;
  private readonly maxSessions: number;
  private readonly exitedRetentionMs: number;
  private readonly onEvent?: (event: ProcessManagerEvent) => void;
  private readonly workerRoot?: string;
  private readonly workerEntrypoint?: string;
  private readonly workerExecArgv: string[];
  private persistChain: Promise<void> = Promise.resolve();
  private readonly durableMonitors = new Map<string, NodeJS.Timeout>();

  constructor(options: ProcessManagerOptions = {}) {
    this.stateFile = options.stateFile;
    this.maxSessions = options.maxSessions ?? 128;
    this.exitedRetentionMs =
      options.exitedRetentionMs ?? 24 * 60 * 60 * 1000;
    this.onEvent = options.onEvent;
    this.workerRoot = options.workerRoot;
    this.workerEntrypoint = options.workerEntrypoint;
    this.workerExecArgv = options.workerExecArgv ?? process.execArgv;
  }

  private emit(event: ProcessManagerEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // Event delivery must never interfere with process control.
    }
  }

  async initialize(): Promise<void> {
    if (!this.stateFile) return;

    let raw: string;
    try {
      raw = await fs.readFile(this.stateFile, 'utf8');
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return;
      }
      throw error;
    }

    const state = PersistedStateSchema.parse(JSON.parse(raw));
    const now = Date.now();

    for (const saved of state.sessions) {
      const ageAnchor = saved.exitedAt ?? saved.startedAt;
      if (
        saved.status !== 'running' &&
        saved.status !== 'orphaned' &&
        now - Date.parse(ageAnchor) > this.exitedRetentionMs
      ) {
        continue;
      }

      const durable = saved.durable ?? false;
      let status: SessionStatus = saved.status;
      let exitedAt = saved.exitedAt;
      let pid = saved.pid;
      let exitCode = saved.exitCode;
      let signal = saved.signal as NodeJS.Signals | null;
      let workerPid = saved.workerPid ?? null;
      let events: ProcessOutputEvent[] = [];
      let nextSeq = 1;
      let maxBufferBytes = 4_194_304;

      if (durable && saved.workerDir) {
        try {
          const workerStatus = await readJsonIfExists(
            path.join(saved.workerDir, 'status.json'),
            WorkerStatusSchema,
          );
          events = await readWorkerEvents(saved.workerDir);
          nextSeq =
            Math.max(
              workerStatus?.nextSeq ?? 1,
              (events.at(-1)?.seq ?? 0) + 1,
            );
          maxBufferBytes =
            workerStatus?.maxBufferBytes ?? maxBufferBytes;

          if (workerStatus) {
            workerPid = workerStatus.workerPid;
            pid = workerStatus.childPid;
            exitCode = workerStatus.exitCode;
            signal = workerStatus.signal as NodeJS.Signals | null;
            if (
              workerStatus.status === 'running' &&
              isPidAlive(workerStatus.workerPid)
            ) {
              status = 'running';
              exitedAt = undefined;
            } else if (workerStatus.status === 'exited') {
              status = 'exited';
              exitedAt = workerStatus.exitedAt ?? exitedAt;
            } else {
              status = 'lost';
              exitedAt ??= new Date().toISOString();
            }
          } else {
            status = 'lost';
            exitedAt ??= new Date().toISOString();
          }
        } catch {
          status = 'lost';
          exitedAt ??= new Date().toISOString();
        }
      } else if (
        saved.status === 'running' ||
        saved.status === 'orphaned'
      ) {
        if (saved.pid && isPidAlive(saved.pid)) {
          status = 'orphaned';
        } else {
          status = 'lost';
          exitedAt ??= new Date().toISOString();
        }
      }

      this.sessions.set(saved.id, {
        id: saved.id,
        ...(saved.name ? { name: saved.name } : {}),
        pid,
        shell: saved.shell,
        ...(saved.cwd ? { cwd: saved.cwd } : {}),
        startedAt: saved.startedAt,
        ...(exitedAt ? { exitedAt } : {}),
        exitCode,
        signal,
        status,
        recovered: true,
        durable,
        ...(saved.workerDir ? { workerDir: saved.workerDir } : {}),
        ...(workerPid !== undefined ? { workerPid } : {}),
        events,
        nextSeq,
        bufferedBytes: events.reduce(
          (total, event) => total + Buffer.byteLength(event.text),
          0,
        ),
        maxBufferBytes,
      });
    }

    this.pruneExpiredInMemory();
    await this.persistState();
  }

  private async refreshDurableSession(
    session: ManagedSession,
    emitEvents = true,
  ): Promise<void> {
    if (!session.durable || !session.workerDir) return;

    const previousLatest = session.events.at(-1)?.seq ?? 0;
    const previousStatus = session.status;
    const [workerStatus, events] = await Promise.all([
      readJsonIfExists(
        path.join(session.workerDir, 'status.json'),
        WorkerStatusSchema,
      ),
      readWorkerEvents(session.workerDir),
    ]);

    if (!workerStatus) {
      if (session.status === 'running') {
        session.status = 'lost';
        session.exitedAt ??= new Date().toISOString();
      }
      return;
    }

    session.workerPid = workerStatus.workerPid;
    session.pid = workerStatus.childPid;
    session.exitCode = workerStatus.exitCode;
    session.signal = workerStatus.signal as NodeJS.Signals | null;
    session.nextSeq = Math.max(
      workerStatus.nextSeq,
      (events.at(-1)?.seq ?? 0) + 1,
    );
    session.maxBufferBytes = workerStatus.maxBufferBytes;
    session.events = events;
    session.bufferedBytes = events.reduce(
      (total, event) => total + Buffer.byteLength(event.text),
      0,
    );

    if (
      workerStatus.status === 'running' &&
      isPidAlive(workerStatus.workerPid)
    ) {
      session.status = 'running';
      delete session.exitedAt;
    } else if (workerStatus.status === 'exited') {
      session.status = 'exited';
      session.exitedAt =
        workerStatus.exitedAt ?? session.exitedAt ?? new Date().toISOString();
    } else if (!isPidAlive(workerStatus.workerPid)) {
      session.status = 'lost';
      session.exitedAt ??= new Date().toISOString();
    }

    if (emitEvents) {
      for (const event of events) {
        if (event.seq <= previousLatest) continue;
        this.emit({
          topic: 'process.output',
          data: {
            sessionId: session.id,
            seq: event.seq,
            stream: event.stream,
            text: event.text,
            at: event.at,
          },
        });
      }

      if (
        previousStatus === 'running' &&
        session.status !== 'running'
      ) {
        this.emit({
          topic: 'process.exited',
          data: {
            sessionId: session.id,
            pid: session.pid,
            exitCode: session.exitCode,
            signal: session.signal,
            exitedAt: session.exitedAt,
          },
        });
      }
    }
  }

  private startDurableMonitor(session: ManagedSession): void {
    if (!session.durable || session.status !== 'running') return;
    if (this.durableMonitors.has(session.id)) return;

    let refreshing = false;
    const timer = setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void this.refreshDurableSession(session)
        .then(async () => {
          if (session.status !== 'running') {
            this.stopDurableMonitor(session.id);
            await this.persistState();
          }
        })
        .catch(() => undefined)
        .finally(() => {
          refreshing = false;
        });
    }, 100);
    timer.unref();
    this.durableMonitors.set(session.id, timer);
  }

  private stopDurableMonitor(sessionId: string): void {
    const timer = this.durableMonitors.get(sessionId);
    if (timer) clearInterval(timer);
    this.durableMonitors.delete(sessionId);
  }

  private async workerControl(
    session: ManagedSession,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!session.workerDir) {
      throw new ProcessManagerError(
        'PROCESS_SESSION_NOT_REATTACHABLE',
        'Durable process session has no worker directory.',
      );
    }
    const control = await readJsonIfExists(
      path.join(session.workerDir, 'control.json'),
      WorkerControlSchema,
    );
    if (!control) {
      throw new ProcessManagerError(
        'PROCESS_SESSION_NOT_REATTACHABLE',
        'Durable process worker control metadata is unavailable.',
      );
    }
    if (!isPidAlive(control.workerPid)) {
      throw new ProcessManagerError(
        'PROCESS_SESSION_NOT_REATTACHABLE',
        'Durable process worker is not running.',
      );
    }
    return await sendWorkerControl(control, payload);
  }

  private async startDurable(
    parsed: z.infer<typeof StartSchema>,
    cwd: string | undefined,
  ) {
    if (!this.workerRoot || !this.workerEntrypoint) {
      throw new ProcessManagerError(
        'PROCESS_DURABLE_UNAVAILABLE',
        'Durable process sessions require workerRoot and workerEntrypoint.',
      );
    }

    const id = randomUUID();
    const workerDir = path.join(this.workerRoot, id);
    await fs.mkdir(workerDir, { recursive: true, mode: 0o700 });

    const token = randomBytes(32).toString('hex');
    const shell = resolveShell(parsed.shell, parsed.command);
    const worker = spawn(
      process.execPath,
      [
        ...this.workerExecArgv,
        this.workerEntrypoint,
        'process-worker',
        workerDir,
      ],
      {
        windowsHide: true,
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
        env: process.env,
      },
    );

    const initPayload = {
      sessionId: id,
      command: parsed.command,
      ...(parsed.shell ? { shell: parsed.shell } : {}),
      ...(cwd ? { cwd } : {}),
      maxBufferBytes: parsed.max_buffer_bytes,
      token,
    };

    await new Promise<void>((resolve, reject) => {
      worker.stdin.end(JSON.stringify(initPayload), (error) =>
        error ? reject(error) : resolve(),
      );
    });

    const deadline = Date.now() + 10_000;
    let control: WorkerControl | undefined;
    let workerStatus: WorkerStatus | undefined;

    while (Date.now() < deadline) {
      if (worker.exitCode !== null) {
        throw new ProcessManagerError(
          'PROCESS_WORKER_START_FAILED',
          `Durable process worker exited with code ${worker.exitCode} before becoming ready.`,
        );
      }

      try {
        [control, workerStatus] = await Promise.all([
          readJsonIfExists(
            path.join(workerDir, 'control.json'),
            WorkerControlSchema,
          ),
          readJsonIfExists(
            path.join(workerDir, 'status.json'),
            WorkerStatusSchema,
          ),
        ]);
      } catch {
        control = undefined;
        workerStatus = undefined;
      }

      if (
        control &&
        workerStatus &&
        workerStatus.status !== 'starting'
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (!control || !workerStatus) {
      try {
        process.kill(worker.pid!, 'SIGTERM');
      } catch {
        // Best effort worker cleanup.
      }
      throw new ProcessManagerError(
        'PROCESS_WORKER_START_TIMEOUT',
        'Durable process worker did not publish ready state.',
      );
    }

    worker.unref();
    const events = await readWorkerEvents(workerDir);
    const session: ManagedSession = {
      id,
      ...(parsed.name ? { name: parsed.name } : {}),
      pid: workerStatus.childPid,
      command: parsed.command,
      shell: shell.label,
      ...(cwd ? { cwd } : {}),
      startedAt: workerStatus.startedAt,
      ...(workerStatus.exitedAt
        ? { exitedAt: workerStatus.exitedAt }
        : {}),
      exitCode: workerStatus.exitCode,
      signal: workerStatus.signal as NodeJS.Signals | null,
      status:
        workerStatus.status === 'exited' ? 'exited' : 'running',
      recovered: false,
      durable: true,
      workerDir,
      workerPid: control.workerPid,
      events,
      nextSeq: Math.max(
        workerStatus.nextSeq,
        (events.at(-1)?.seq ?? 0) + 1,
      ),
      bufferedBytes: events.reduce(
        (total, event) => total + Buffer.byteLength(event.text),
        0,
      ),
      maxBufferBytes: workerStatus.maxBufferBytes,
    };

    this.sessions.set(id, session);
    this.emit({
      topic: 'process.started',
      data: {
        sessionId: session.id,
        ...(session.name ? { name: session.name } : {}),
        pid: session.pid,
        shell: session.shell,
        ...(session.cwd ? { cwd: session.cwd } : {}),
        startedAt: session.startedAt,
        durable: true,
      },
    });
    this.startDurableMonitor(session);
    await this.persistState();
    return summarize(session);
  }

  async start(input: unknown, policy: PathPolicy) {
    const parsed = StartSchema.parse(input);
    this.pruneExpiredInMemory();

    if (this.sessions.size >= this.maxSessions) {
      throw new ProcessManagerError(
        'PROCESS_SESSION_LIMIT',
        `Process session limit reached (${this.maxSessions}). Prune old sessions before starting another.`,
      );
    }

    const cwd = parsed.cwd
      ? await policy.resolveExisting(parsed.cwd)
      : undefined;
    const shell = resolveShell(parsed.shell, parsed.command);
    const child = spawn(shell.executable, shell.args, {
      ...(cwd ? { cwd } : {}),
      windowsHide: true,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    const id = randomUUID();
    const session: ManagedSession = {
      id,
      ...(parsed.name ? { name: parsed.name } : {}),
      pid: child.pid ?? null,
      command: parsed.command,
      shell: shell.label,
      ...(cwd ? { cwd } : {}),
      child,
      startedAt: new Date().toISOString(),
      exitCode: null,
      signal: null,
      status: 'running',
      recovered: false,
      events: [],
      nextSeq: 1,
      bufferedBytes: 0,
      maxBufferBytes: parsed.max_buffer_bytes,
    };
    this.sessions.set(id, session);
    this.emit({
      topic: 'process.started',
      data: {
        sessionId: session.id,
        ...(session.name ? { name: session.name } : {}),
        pid: session.pid,
        shell: session.shell,
        ...(session.cwd ? { cwd: session.cwd } : {}),
        startedAt: session.startedAt,
      },
    });

    const append = (
      stream: 'stdout' | 'stderr',
      chunk: Buffer,
    ): void => {
      const text = chunk.toString('utf8');
      const bytes = Buffer.byteLength(text);
      const event = {
        seq: session.nextSeq++,
        stream,
        text,
        at: new Date().toISOString(),
      } as const;
      session.events.push(event);
      session.bufferedBytes += bytes;
      this.emit({
        topic: 'process.output',
        data: {
          sessionId: session.id,
          seq: event.seq,
          stream: event.stream,
          text: event.text,
          at: event.at,
        },
      });

      while (
        session.bufferedBytes > session.maxBufferBytes &&
        session.events.length > 1
      ) {
        const removed = session.events.shift();
        if (removed) {
          session.bufferedBytes -= Buffer.byteLength(removed.text);
        }
      }
    };

    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.once('error', (error) => {
      append('stderr', Buffer.from(`Process error: ${error.message}\n`));
    });
    child.once('close', (code, signal) => {
      session.status = 'exited';
      session.exitCode = code;
      session.signal = signal;
      session.exitedAt = new Date().toISOString();
      this.emit({
        topic: 'process.exited',
        data: {
          sessionId: session.id,
          pid: session.pid,
          exitCode: session.exitCode,
          signal: session.signal,
          exitedAt: session.exitedAt,
        },
      });
      void this.persistState().catch(() => undefined);
    });

    await this.persistState();
    return summarize(session);
  }

  async read(input: unknown) {
    const parsed = ReadSchema.parse(input);
    const session = this.require(parsed.session_id);
    const deadline = Date.now() + parsed.wait_ms;

    let events = session.events
      .filter((event) => event.seq > parsed.after_seq)
      .slice(0, parsed.max_events);

    while (
      events.length === 0 &&
      session.status === 'running' &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(50, Math.max(1, deadline - Date.now())),
        ),
      );
      events = session.events
        .filter((event) => event.seq > parsed.after_seq)
        .slice(0, parsed.max_events);
    }

    return {
      session: summarize(session),
      events,
      nextSeq: events.at(-1)?.seq ?? parsed.after_seq,
    };
  }

  async write(input: unknown) {
    const parsed = WriteSchema.parse(input);
    const session = this.require(parsed.session_id);

    if (
      session.status !== 'running' ||
      !session.child ||
      !session.child.stdin.writable
    ) {
      throw new ProcessManagerError(
        session.recovered
          ? 'PROCESS_SESSION_NOT_REATTACHABLE'
          : 'PROCESS_NOT_RUNNING',
        session.recovered
          ? 'Recovered process sessions cannot restore stdin/stdout pipes after an agent restart.'
          : 'Process session is not accepting input.',
      );
    }

    const value =
      parsed.input + (parsed.append_newline ? '\n' : '');
    await new Promise<void>((resolve, reject) =>
      session.child!.stdin.write(value, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    this.emit({
      topic: 'process.input',
      data: {
        sessionId: session.id,
        bytes: Buffer.byteLength(value),
        appendNewline: parsed.append_newline,
      },
    });
    return summarize(session);
  }

  private async waitForChildClose(
    session: ManagedSession,
    timeoutMs = 2_000,
  ): Promise<void> {
    if (!session.child || session.status !== 'running') return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      session.child!.once('close', finish);
      if (session.status !== 'running') finish();
    });
  }

  async stop(input: unknown) {
    const parsed = SessionSchema.parse(input);
    const session = this.require(parsed.session_id);

    if (session.status === 'orphaned' && session.recovered) {
      throw new ProcessManagerError(
        'PROCESS_RECOVERY_VERIFICATION_REQUIRED',
        'The process still appears alive after an agent restart, but Nexowire will not signal a recovered PID without a verifiable process identity. Inspect the process and stop it through an explicit OS-level control path if appropriate.',
      );
    }

    if (
      (session.status === 'running' ||
        session.status === 'orphaned') &&
      session.pid
    ) {
      await killPidTree(session.pid);
      await this.waitForChildClose(session);

      for (let attempt = 0; attempt < 20; attempt++) {
        if (!isPidAlive(session.pid)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      if (!isPidAlive(session.pid) && !session.exitedAt) {
        session.status = 'exited';
        session.exitCode = null;
        session.signal = null;
        session.exitedAt ??= new Date().toISOString();
      }
    }

    await this.persistState();
    return summarize(session);
  }

  list() {
    this.pruneExpiredInMemory();
    return [...this.sessions.values()]
      .map(summarize)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async prune(input: unknown = {}) {
    const parsed = PruneSchema.parse(input);
    const olderThanMs =
      parsed.older_than_ms ?? this.exitedRetentionMs;
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;

    for (const [id, session] of this.sessions) {
      if (
        session.status === 'running' ||
        session.status === 'orphaned'
      ) {
        continue;
      }
      const anchor = session.exitedAt ?? session.startedAt;
      if (Date.parse(anchor) <= cutoff) {
        this.sessions.delete(id);
        removed++;
      }
    }

    await this.persistState();
    return {
      removed,
      remaining: this.sessions.size,
    };
  }

  async stopAll(): Promise<void> {
    const active = [...this.sessions.values()].filter(
      (session) =>
        session.status === 'running' &&
        !session.recovered &&
        session.pid,
    );

    await Promise.all(
      active.map(async (session) => {
        await killPidTree(session.pid!);
        await this.waitForChildClose(session);
        for (let attempt = 0; attempt < 20; attempt++) {
          if (!isPidAlive(session.pid!)) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (!isPidAlive(session.pid!) && !session.exitedAt) {
          session.status = 'exited';
          session.exitCode = null;
          session.signal = null;
          session.exitedAt ??= new Date().toISOString();
        }
      }),
    );
    await this.persistState();
  }

  private require(id: string): ManagedSession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new ProcessManagerError(
        'PROCESS_NOT_FOUND',
        `Unknown process session: ${id}`,
      );
    }
    return session;
  }

  private pruneExpiredInMemory(): void {
    const cutoff = Date.now() - this.exitedRetentionMs;
    for (const [id, session] of this.sessions) {
      if (
        session.status === 'running' ||
        session.status === 'orphaned'
      ) {
        continue;
      }
      const anchor = session.exitedAt ?? session.startedAt;
      if (Date.parse(anchor) <= cutoff) {
        this.sessions.delete(id);
      }
    }
  }

  private async persistState(): Promise<void> {
    if (!this.stateFile) return;

    const snapshot = {
      version: 1 as const,
      sessions: [...this.sessions.values()].map((session) => ({
        id: session.id,
        ...(session.name ? { name: session.name } : {}),
        pid: session.pid,
        shell: session.shell,
        ...(session.cwd ? { cwd: session.cwd } : {}),
        startedAt: session.startedAt,
        ...(session.exitedAt ? { exitedAt: session.exitedAt } : {}),
        exitCode: session.exitCode,
        signal: session.signal,
        status: session.status,
      })),
    };

    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(this.stateFile!), {
          recursive: true,
        });
        const temp = this.stateFile! + '.tmp';
        await fs.writeFile(
          temp,
          JSON.stringify(snapshot, null, 2) + '\n',
          'utf8',
        );
        await fs.rename(temp, this.stateFile!);
      });
    await this.persistChain;
  }
}
