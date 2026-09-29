import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod';
import type { PathPolicy } from './path-policy.js';
import {
  durableProcessRpc,
  readDurableMeta,
  removeDurableSessionFiles,
  startDurableProcess,
  type DurableProcessSummary,
} from './durable-process-client.js';

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
  durable: z.boolean().optional(),
  hostPid: z.number().int().positive().optional(),
  status: z.enum(['running', 'exited', 'orphaned', 'lost']),
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
  hostPid?: number;
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
  durableRoot?: string;
  onEvent?: (event: ProcessManagerEvent) => void;
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
    ...(session.hostPid ? { hostPid: session.hostPid } : {}),
    interactive:
      session.status === 'running' &&
      (session.durable ||
        (session.child !== undefined && session.child.stdin.writable)),
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
  private readonly durableRoot: string;
  private readonly onEvent?: (event: ProcessManagerEvent) => void;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(options: ProcessManagerOptions = {}) {
    this.stateFile = options.stateFile;
    this.maxSessions = options.maxSessions ?? 128;
    this.exitedRetentionMs =
      options.exitedRetentionMs ?? 24 * 60 * 60 * 1000;
    this.durableRoot =
      options.durableRoot ??
      (this.stateFile
        ? path.join(path.dirname(this.stateFile), 'process-hosts')
        : path.join(os.homedir(), '.nexowire', 'process-hosts'));
    this.onEvent = options.onEvent;
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

      let status: SessionStatus = saved.status;
      let exitedAt = saved.exitedAt;
      if (saved.status === 'running' || saved.status === 'orphaned') {
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
        pid: saved.pid,
        shell: saved.shell,
        ...(saved.cwd ? { cwd: saved.cwd } : {}),
        startedAt: saved.startedAt,
        ...(exitedAt ? { exitedAt } : {}),
        exitCode: saved.exitCode,
        signal: saved.signal as NodeJS.Signals | null,
        status,
        recovered: true,
        events: [],
        nextSeq: 1,
        bufferedBytes: 0,
        maxBufferBytes: 4_194_304,
      });
    }

    this.pruneExpiredInMemory();
    await this.persistState();
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
