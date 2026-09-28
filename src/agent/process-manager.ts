import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as z from 'zod';
import type { PathPolicy } from './path-policy.js';

const ShellSchema = z.enum(['pwsh', 'powershell', 'cmd', 'bash', 'sh']);
const StartSchema = z.object({
  command: z.string().min(1).max(200_000),
  shell: ShellSchema.optional(),
  cwd: z.string().max(4096).optional(),
  name: z.string().min(1).max(128).optional(),
  max_buffer_bytes: z.number().int().min(65_536).max(16_777_216).default(4_194_304),
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

export interface ProcessOutputEvent {
  seq: number;
  stream: 'stdout' | 'stderr';
  text: string;
  at: string;
}

interface ManagedSession {
  id: string;
  name?: string;
  command: string;
  shell: string;
  cwd?: string;
  child: ChildProcessWithoutNullStreams;
  startedAt: string;
  exitedAt?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  status: 'running' | 'exited';
  events: ProcessOutputEvent[];
  nextSeq: number;
  bufferedBytes: number;
  maxBufferBytes: number;
}

export class ProcessManagerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ProcessManagerError';
  }
}

function hasExecutable(command: string): boolean {
  const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { windowsHide: true, stdio: 'ignore' });
  return probe.status === 0;
}

function resolveShell(shell: z.infer<typeof ShellSchema> | undefined, command: string): { executable: string; args: string[]; label: string } {
  if (process.platform === 'win32') {
    const selected = shell ?? (hasExecutable('pwsh.exe') ? 'pwsh' : 'powershell');
    if (selected === 'pwsh') return { executable: 'pwsh.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], label: selected };
    if (selected === 'powershell') return { executable: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], label: selected };
    if (selected === 'cmd') return { executable: 'cmd.exe', args: ['/D', '/S', '/C', command], label: selected };
    return { executable: selected, args: ['-lc', command], label: selected };
  }
  if (shell === 'cmd' || shell === 'powershell') throw new ProcessManagerError('SHELL_UNAVAILABLE', `Shell ${shell} is unavailable on this platform.`);
  if (shell === 'pwsh') return { executable: 'pwsh', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], label: shell };
  const selected = shell === 'sh' ? 'sh' : 'bash';
  return { executable: selected, args: ['-lc', command], label: selected };
}

async function killTree(session: ManagedSession): Promise<void> {
  const pid = session.child.pid;
  if (!pid || session.status !== 'running') return;
  if (process.platform === 'win32') {
    spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { session.child.kill('SIGTERM'); }
}

function summarize(session: ManagedSession) {
  return {
    sessionId: session.id,
    ...(session.name ? { name: session.name } : {}),
    pid: session.child.pid ?? null,
    command: session.command,
    shell: session.shell,
    ...(session.cwd ? { cwd: session.cwd } : {}),
    status: session.status,
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

  async start(input: unknown, policy: PathPolicy) {
    const parsed = StartSchema.parse(input);
    const cwd = parsed.cwd ? policy.resolve(parsed.cwd) : undefined;
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
      command: parsed.command,
      shell: shell.label,
      ...(cwd ? { cwd } : {}),
      child,
      startedAt: new Date().toISOString(),
      exitCode: null,
      signal: null,
      status: 'running',
      events: [],
      nextSeq: 1,
      bufferedBytes: 0,
      maxBufferBytes: parsed.max_buffer_bytes,
    };
    this.sessions.set(id, session);
    const append = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      const bytes = Buffer.byteLength(text);
      session.events.push({ seq: session.nextSeq++, stream, text, at: new Date().toISOString() });
      session.bufferedBytes += bytes;
      while (session.bufferedBytes > session.maxBufferBytes && session.events.length > 1) {
        const removed = session.events.shift();
        if (removed) session.bufferedBytes -= Buffer.byteLength(removed.text);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.once('error', (error) => append('stderr', Buffer.from(`Process error: ${error.message}\n`)));
    child.once('close', (code, signal) => {
      session.status = 'exited';
      session.exitCode = code;
      session.signal = signal;
      session.exitedAt = new Date().toISOString();
    });
    return summarize(session);
  }

  async read(input: unknown) {
    const parsed = ReadSchema.parse(input);
    const session = this.require(parsed.session_id);
    const deadline = Date.now() + parsed.wait_ms;
    let events = session.events.filter((event) => event.seq > parsed.after_seq).slice(0, parsed.max_events);
    while (events.length === 0 && session.status === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
      events = session.events.filter((event) => event.seq > parsed.after_seq).slice(0, parsed.max_events);
    }
    return { session: summarize(session), events, nextSeq: events.at(-1)?.seq ?? parsed.after_seq };
  }

  async write(input: unknown) {
    const parsed = WriteSchema.parse(input);
    const session = this.require(parsed.session_id);
    if (session.status !== 'running' || !session.child.stdin.writable) throw new ProcessManagerError('PROCESS_NOT_RUNNING', 'Process session is not accepting input.');
    const value = parsed.input + (parsed.append_newline ? '\n' : '');
    await new Promise<void>((resolve, reject) => session.child.stdin.write(value, (error) => error ? reject(error) : resolve()));
    return summarize(session);
  }

  async stop(input: unknown) {
    const parsed = SessionSchema.parse(input);
    const session = this.require(parsed.session_id);
    await killTree(session);
    return summarize(session);
  }

  list() {
    return [...this.sessions.values()].map(summarize).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => killTree(session)));
  }

  private require(id: string): ManagedSession {
    const session = this.sessions.get(id);
    if (!session) throw new ProcessManagerError('PROCESS_NOT_FOUND', `Unknown process session: ${id}`);
    return session;
  }
}
