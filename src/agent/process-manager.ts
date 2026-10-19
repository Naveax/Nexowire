import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import * as z from 'zod';
import type { PathPolicy } from './path-policy.js';
import {executeWindowsPrivateDesktopCapability} from './windows-private-desktop.js';
import {privateShellExecutionEnvironment,assertNoObviousPrivateShellBrokerInvocation} from './windows-private-shell.js';
import {assertNoObviousPrivateShellScriptBrokerInvocation} from './windows-private-shell-broker-guard.js';
import {resolveAiWorkspaceTarget} from './ai-workspace-default.js';
import {launchWindowsJob, requestWindowsJobStop, type WindowsJobLaunch} from './windows-job-owner.js';

const ShellSchema = z.enum(['pwsh', 'powershell', 'cmd', 'bash', 'sh']);

const StartSchema = z.object({
  command: z.string().min(1).max(200_000),
  shell: ShellSchema.optional(),
  cwd: z.string().max(4096).optional(),
  name: z.string().min(1).max(128).optional(),
  durable: z.boolean().default(false),
  ui_target: z.enum(['headless','private_desktop']).optional(),
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
  uiTarget: z.enum(['headless','private_desktop']).optional(),
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
  job?: WindowsJobLaunch;
  processCreationFiletime?: string;
  startedAt: string;
  exitedAt?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  status: SessionStatus;
  recovered: boolean;
  durable: boolean;
  uiTarget?: 'headless'|'private_desktop';
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

async function readDurableWorkerStatus(
  workerDir: string,
  expectedSessionId: string,
): Promise<WorkerStatus | undefined> {
  const statusFile = path.join(workerDir, 'status.json');
  const current = await readJsonIfExists(
    statusFile,
    WorkerStatusSchema,
  );

  if (
    current?.status === 'exited' ||
    (current &&
      (current.sessionId !== expectedSessionId ||
        isPidAlive(current.workerPid)))
  ) {
    return current;
  }

  const pending = await readJsonIfExists(
    statusFile + '.tmp',
    WorkerStatusSchema,
  );
  if (
    pending?.status === 'exited' &&
    pending.sessionId === expectedSessionId &&
    (!current || pending.workerPid === current.workerPid)
  ) {
    return pending;
  }

  return current;
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

async function killPidTree(pid: number): Promise<'requested' | 'unconfirmed'> {
  if (process.platform === 'win32') {
    // taskkill /T can fail when the shell PID has already exited while its
    // descendants remain alive (and may still hold stdout/stderr pipes).
    // Never discard a nonzero status or spawn error as a successful cleanup.
    const outcome = await new Promise<{
      code: number | null; error?: string;
    }>((resolve) => {
      let completed = false;
      const settle = (result: {code:number|null;error?:string}) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        resolve(result);
      };
      const killer = spawn(
        'taskkill.exe',
        ['/PID', String(pid), '/T', '/F'],
        {windowsHide:true,stdio:'ignore'},
      );
      killer.once('error', (error) =>
        settle({code:null,error:error.message}));
      killer.once('close', (code) => settle({code}));
      const timer = setTimeout(() => {
        killer.kill();
        settle({code:null,error:'taskkill did not terminate within 10 seconds'});
      },10_000);
    });
    if (outcome.code === 0) return 'requested';
    // A gone root is not evidence its descendants were reaped.
    if (!isPidAlive(pid)) return 'unconfirmed';
    throw new ProcessManagerError(
      'PROCESS_TREE_TERMINATION_UNCONFIRMED',
      'Windows process-tree termination was not confirmed for the owned shell PID '+
      pid+' (exitCode='+String(outcome.code)+
      (outcome.error?', reason='+outcome.error.slice(0,180):'')+
      '). Do not assume child processes stopped.',
    );
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
  return 'requested';
}

function summarize(session: ManagedSession) {
  return {
    sessionId: session.id,
    ...(session.name ? { name: session.name } : {}),
    pid: session.pid,
    ...(session.command ? { command: session.command } : {}),
    shell: session.shell,
    ...(session.cwd ? { cwd: session.cwd } : {}),
    ...(session.processCreationFiletime ? {
      processCreationFiletime: session.processCreationFiletime,
    } : {}),
    ...(session.job ? { jobGuardianPid: session.job.guardianPid,
      treeOwnership: 'windows_job' as const } : {}),
    status: session.status,
    recovered: session.recovered,
    durable: session.durable,
    uiTarget: session.uiTarget ?? 'headless',
    ...(session.uiTarget==='private_desktop'?{desktopName:'NexowirePrivate'}:{}),
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
  // Reserve slots before any async spawn/setup work to avoid oversubscription.
  private pendingStarts = 0;
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
          const workerStatus = await readDurableWorkerStatus(
            saved.workerDir,
            saved.id,
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
        uiTarget:saved.uiTarget ?? 'headless',
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
      const recoveredSession = this.sessions.get(saved.id);
      if (
        recoveredSession?.durable &&
        recoveredSession.status === 'running'
      ) {
        this.startDurableMonitor(recoveredSession);
      }
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
      readDurableWorkerStatus(
        session.workerDir,
        session.id,
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
    onRegistered: () => void,
  ) {
    if (!this.workerRoot || !this.workerEntrypoint) {
      throw new ProcessManagerError(
        'PROCESS_DURABLE_UNAVAILABLE',
        'Durable process sessions require workerRoot and workerEntrypoint.',
      );
    }

    const privateDesktop=parsed.ui_target==='private_desktop';
    if(privateDesktop && process.platform!=='win32'){
      throw new ProcessManagerError(
        'PRIVATE_PROCESS_WINDOWS_ONLY','Private process sessions require Windows.',
      );
    }
    const shell = resolveShell(parsed.shell, parsed.command);
    if(privateDesktop){
      // Durable worker's own spawn() otherwise bypasses the direct
      // private-desktop launcher broker denylist.
      await assertNoObviousPrivateShellScriptBrokerInvocation(
        shell.executable,shell.args,cwd,
      );
    }
    const id = randomUUID();
    const workerDir = path.join(this.workerRoot, id);
    await fs.mkdir(workerDir, { recursive: true, mode: 0o700 });

    const token = randomBytes(32).toString('hex');

    const initPayload = {
      sessionId: id,
      command: parsed.command,
      ...(parsed.shell ? { shell: parsed.shell } : {}),
      ...(cwd ? { cwd } : {}),
      maxBufferBytes: parsed.max_buffer_bytes,
      token,
      ...(privateDesktop?{executionEnv:privateShellExecutionEnvironment()}:{}),
    };
    const args=[
      ...this.workerExecArgv,this.workerEntrypoint,'process-worker',workerDir,
    ];
    let worker:ReturnType<typeof spawn>|undefined;
    let workerPid:number|undefined;
    if(privateDesktop){
      // A private worker is created *directly* on NexowirePrivate.
      // The shared user's Default desktop must not become a fallback.
      await executeWindowsPrivateDesktopCapability(
        'windows.private_desktop.start',{create_shortcut:false},
      );
      await fs.writeFile(path.join(workerDir,'init.json'),JSON.stringify(initPayload),{
        flag:'wx',mode:0o600,
      });
      try{
        const launch=await executeWindowsPrivateDesktopCapability(
          'windows.private_desktop.launch',{
            executable:process.execPath,args:[...args,'--init-file'],
            cwd:path.dirname(this.workerEntrypoint),
          },
        ) as {data:{pid:number}};
        workerPid=launch.data.pid;
      }catch(error){
        await fs.rm(path.join(workerDir,'init.json'),{force:true});
        throw error;
      }
    }else{
      worker=spawn(process.execPath,args,{
        windowsHide:true,detached:true,
        stdio:['pipe','ignore','ignore'],env:process.env,
      });
      workerPid=worker.pid;
      const workerStdin=worker.stdin;
      if(!workerStdin){
        throw new ProcessManagerError(
          'PROCESS_WORKER_STDIN_UNAVAILABLE',
          'Durable worker has no initialization input pipe.',
        );
      }
      await new Promise<void>((resolve,reject)=>{
        const fail=(error:Error):void=>{
          workerStdin.off('error',fail);
          reject(error);
        };
        workerStdin.once('error',fail);
        workerStdin.end(JSON.stringify(initPayload),()=>{
          workerStdin.off('error',fail);
          resolve();
        });
      });
    }

    const deadline = Date.now() + 10_000;
    let control: WorkerControl | undefined;
    let workerStatus: WorkerStatus | undefined;

    while (Date.now() < deadline) {
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
        if(privateDesktop && (
          control.workerPid!==workerPid ||
          workerStatus.workerPid!==workerPid ||
          control.sessionId!==id || workerStatus.sessionId!==id
        )){
          throw new ProcessManagerError(
            'PRIVATE_PROCESS_WORKER_IDENTITY_MISMATCH',
            'Private process worker reported a different session or PID.',
          );
        }
        break;
      }
      if((worker && worker.exitCode!==null) ||
         (privateDesktop && (!workerPid || !isPidAlive(workerPid)))){
        if(privateDesktop){
          await fs.rm(path.join(workerDir,'init.json'),{force:true});
        }
        throw new ProcessManagerError(
          'PROCESS_WORKER_START_FAILED',
          'Durable process worker exited before publishing usable state.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (!control || !workerStatus) {
      try {
        if(workerPid)process.kill(workerPid, 'SIGTERM');
      } catch {
        // Best effort worker cleanup.
      }
      if(privateDesktop){
        await fs.rm(path.join(workerDir,'init.json'),{force:true});
      }
      throw new ProcessManagerError(
        'PROCESS_WORKER_START_TIMEOUT',
        'Durable process worker did not publish ready state.',
      );
    }

    worker?.unref();
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
      uiTarget:parsed.ui_target,
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
    onRegistered();
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
        uiTarget:session.uiTarget ?? 'headless',
        ...(session.uiTarget==='private_desktop'?{
          desktopName:'NexowirePrivate',
        }:{}),
      },
    });
    this.startDurableMonitor(session);
    await this.persistState();
    return summarize(session);
  }

  async start(input: unknown, policy: PathPolicy) {
    const parsed = StartSchema.parse(input);
    // Reject invalid paths before reclaiming any completed history.
    const cwd = parsed.cwd
      ? await policy.resolveExisting(parsed.cwd)
      : undefined;
    const uiTarget=resolveAiWorkspaceTarget(parsed.ui_target);
    // Reserve synchronously once preflight has completed. No awaits between
    // checking the budget and reserving a slot for this start request.
    // Running/orphaned sessions are never reclaimed automatically.
    this.pruneExpiredInMemory();
    while (this.sessions.size + this.pendingStarts >= this.maxSessions) {
      if (!this.reclaimOldestExitedSession()) {
        throw new ProcessManagerError(
          'PROCESS_SESSION_LIMIT',
          `Process session limit reached (${this.maxSessions}); ${this.sessions.size} retained, ${this.pendingStarts} starting. No completed session is available for safe automatic reclamation.`,
        );
      }
    }
    this.pendingStarts++;
    let reservationHeld = true;
    try {

    if(parsed.durable || uiTarget==='private_desktop'){
      return await this.startDurable({...parsed,ui_target:uiTarget},cwd,()=>{
        this.pendingStarts--;
        reservationHeld=false;
      });
    }

    const shell = resolveShell(parsed.shell, parsed.command);
    // On Windows the native guardian owns the entire Job lifetime. The root
    // starts suspended and only resumes after a verified Job assignment.
    const job = process.platform === 'win32'
      ? await launchWindowsJob(shell.executable, shell.args, { cwd, env: process.env, guardOnParentExit: true })
      : undefined;
    const child = job?.child ?? spawn(shell.executable, shell.args, {
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
      pid: job?.pid ?? child.pid ?? null,
      command: parsed.command,
      shell: shell.label,
      ...(cwd ? { cwd } : {}),
      child,
      ...(job ? { job, processCreationFiletime: job.creationFiletime } : {}),
      startedAt: new Date().toISOString(),
      exitCode: null,
      signal: null,
      status: 'running',
      recovered: false,
      durable: false,
      uiTarget:'headless',
      events: [],
      nextSeq: 1,
      bufferedBytes: 0,
      maxBufferBytes: parsed.max_buffer_bytes,
    };
    this.sessions.set(id, session);
    // This session occupies its slot now: don't count its reservation twice.
    this.pendingStarts--;
    reservationHeld = false;
    this.emit({
      topic: 'process.started',
      data: {
        sessionId: session.id,
        ...(session.name ? { name: session.name } : {}),
        pid: session.pid,
        shell: session.shell,
        ...(session.cwd ? { cwd: session.cwd } : {}),
        startedAt: session.startedAt,
        uiTarget:'headless',
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
    const markExited = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (session.status === 'exited') return;
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
    };
    child.once('close', markExited);
    // The guardian can exit before start() observes its assignment marker.
    // Its exit is NOT proof stdout/stderr have drained into process events.
    // If Node already emitted 'close' before this handler was attached, only
    // finalize after both readable streams are demonstrably drained/closed.
    const finalizeEarlyClosedGuardian = (): void => {
      if (!job?.closed() || session.status !== 'running') return;
      const done = (stream: typeof child.stdout) =>
        stream.readableEnded || stream.destroyed;
      if (done(child.stdout) && done(child.stderr)) {
        markExited(child.exitCode, child.signalCode);
      }
    };
    if (job) {
      child.stdout.once('end', finalizeEarlyClosedGuardian);
      child.stderr.once('end', finalizeEarlyClosedGuardian);
      child.stdout.once('close', finalizeEarlyClosedGuardian);
      child.stderr.once('close', finalizeEarlyClosedGuardian);
      finalizeEarlyClosedGuardian();
    }

    await this.persistState();
    return summarize(session);
    } finally {
      if (reservationHeld) this.pendingStarts--;
    }
  }

  async read(input: unknown) {
    const parsed = ReadSchema.parse(input);
    const session = this.require(parsed.session_id);
    if (session.durable) {
      await this.refreshDurableSession(session);
    }
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
      if (session.durable) {
        await this.refreshDurableSession(session);
      }
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

    if (session.durable) {
      await this.refreshDurableSession(session);
      if (session.status !== 'running') {
        throw new ProcessManagerError(
          'PROCESS_NOT_RUNNING',
          'Durable process session is not accepting input.',
        );
      }
      const value =
        parsed.input + (parsed.append_newline ? '\n' : '');
      await this.workerControl(session, {
        type: 'write',
        input: parsed.input,
        appendNewline: parsed.append_newline,
        commandId: randomUUID(),
      });
      this.emit({
        topic: 'process.input',
        data: {
          sessionId: session.id,
          bytes: Buffer.byteLength(value),
          appendNewline: parsed.append_newline,
          durable: true,
        },
      });
      return summarize(session);
    }

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
      const child=session.child!;
      const onClose=()=>finish();
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off('close',onClose);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      child.once('close', onClose);
      if (session.status !== 'running') finish();
    });
  }

  async stop(input: unknown) {
    const parsed = SessionSchema.parse(input);
    const session = this.require(parsed.session_id);

    if (session.durable) {
      await this.refreshDurableSession(session);
      let treeCleanup: 'requested' | 'unconfirmed' = 'unconfirmed';
      if (session.status === 'running') {
        const result = await this.workerControl(session, {
          type: 'stop',
          commandId: randomUUID(),
        });
        if (result.treeCleanup === 'requested') treeCleanup = 'requested';
        for (let attempt = 0; attempt < 100; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          await this.refreshDurableSession(session);
          if (session.status !== 'running') break;
        }
      }
      // A worker response merely confirms an attempted Job handle closure.
      // In particular, lost/active durable workers cannot claim tree cleanup.
      if (session.status !== 'exited') treeCleanup = 'unconfirmed';
      this.stopDurableMonitor(session.id);
      await this.persistState();
      return {
        ...summarize(session),
        ...(process.platform === 'win32' ? { treeCleanup } : {}),
      };
    }

    if (session.status === 'orphaned' && session.recovered) {
      throw new ProcessManagerError(
        'PROCESS_RECOVERY_VERIFICATION_REQUIRED',
        'The process still appears alive after an agent restart, but Nexowire will not signal a recovered PID without a verifiable process identity. Inspect the process and stop it through an explicit OS-level control path if appropriate.',
      );
    }

    let treeCleanup: 'requested' | 'unconfirmed' | undefined;
    if (
      (session.status === 'running' ||
        session.status === 'orphaned') &&
      session.pid
    ) {
      treeCleanup = session.job
        ? requestWindowsJobStop(session.job)
        : await killPidTree(session.pid);
      await this.waitForChildClose(session);
      if (session.job && !session.job.closed()) {
        throw new ProcessManagerError('PROCESS_TREE_TERMINATION_UNCONFIRMED',
          'Windows Job guardian has not closed; the owned descendant tree is not confirmed stopped.');
      }

      for (let attempt = 0; attempt < 20; attempt++) {
        if (!isPidAlive(session.pid)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      if (isPidAlive(session.pid)) {
        throw new ProcessManagerError(
          'PROCESS_ROOT_TERMINATION_UNCONFIRMED',
          'Managed process root is still alive after termination attempt; no success was verified.',
        );
      }
      if (!session.exitedAt) {
        session.status = 'exited';
        session.exitCode = null;
        session.signal = null;
        session.exitedAt ??= new Date().toISOString();
      }
    }

    await this.persistState();
    return {
      ...summarize(session),
      ...(process.platform === 'win32' ? {
        // 'requested' means taskkill exited 0, NOT that all descendants
        // were individually verified. An already-exited root is unknown.
        treeCleanup:treeCleanup ?? 'unconfirmed',
      } : {}),
    };
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
        this.stopDurableMonitor(id);
        if (session.durable && session.workerDir) {
          await fs.rm(session.workerDir, {
            recursive: true,
            force: true,
          });
        }
        removed++;
      }
    }

    await this.persistState();
    return {
      removed,
      remaining: this.sessions.size,
    };
  }

  async shutdown(): Promise<void> {
    for (const timer of this.durableMonitors.values()) {
      clearInterval(timer);
    }
    this.durableMonitors.clear();

    const volatile = [...this.sessions.values()].filter(
      (session) =>
        !session.durable &&
        session.status === 'running' &&
        !session.recovered &&
        session.pid,
    );

    await Promise.all(
      volatile.map(async (session) => {
        if (session.job) requestWindowsJobStop(session.job);
        else await killPidTree(session.pid!);
        await this.waitForChildClose(session);
      }),
    );
    await this.persistState();
  }

  async stopAll(): Promise<void> {
    const active = [...this.sessions.values()].filter(
      (session) => session.status === 'running',
    );

    await Promise.all(
      active.map(async (session) => {
        if (session.durable) {
          try {
            await this.workerControl(session, {
              type: 'stop',
              commandId: randomUUID(),
            });
          } catch {
            // Continue with status refresh below.
          }
          for (let attempt = 0; attempt < 100; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            await this.refreshDurableSession(session, false).catch(
              () => undefined,
            );
            if (session.status !== 'running') break;
          }
          this.stopDurableMonitor(session.id);
          return;
        }

        if (session.recovered || !session.pid) return;
        if (session.job) requestWindowsJobStop(session.job);
        else await killPidTree(session.pid);
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

  // When the 24-hour history fills the 128-slot budget, reclaim only the
  // oldest *confirmed exited* session. Lost sessions may have an unknown
  // process state and orphaned/running sessions must remain protected.
  private reclaimOldestExitedSession(): boolean {
    const oldest = [...this.sessions.values()]
      .filter((session) => session.status === 'exited')
      .sort((a, b) =>
        (a.exitedAt ?? a.startedAt).localeCompare(b.exitedAt ?? b.startedAt),
      )[0];
    if (!oldest) return false;
    this.sessions.delete(oldest.id);
    this.stopDurableMonitor(oldest.id);
    if (oldest.durable && oldest.workerDir) {
      void fs.rm(oldest.workerDir, { recursive: true, force: true })
        .catch(() => undefined);
    }
    return true;
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
        this.stopDurableMonitor(id);
        if (session.durable && session.workerDir) {
          void fs.rm(session.workerDir, {
            recursive: true,
            force: true,
          }).catch(() => undefined);
        }
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
        durable: session.durable,
        uiTarget:session.uiTarget ?? 'headless',
        ...(session.workerDir ? { workerDir: session.workerDir } : {}),
        ...(session.workerPid !== undefined
          ? { workerPid: session.workerPid }
          : {}),
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
