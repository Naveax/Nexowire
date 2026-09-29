import { createHash, timingSafeEqual } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net, { type Server, type Socket } from 'node:net';
import path from 'node:path';

interface HostSpec {
  version: 1;
  sessionId: string;
  token: string;
  address: string;
  root: string;
  executable: string;
  args: string[];
  shell: string;
  cwd?: string;
  maxBufferBytes: number;
}

interface OutputEvent {
  seq: number;
  stream: 'stdout' | 'stderr';
  text: string;
  at: string;
}

interface HostState {
  child: ChildProcessWithoutNullStreams;
  status: 'running' | 'exited';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  exitedAt?: string;
  events: OutputEvent[];
  nextSeq: number;
  bufferedBytes: number;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function tokenMatches(candidate: unknown, expected: string): boolean {
  return (
    typeof candidate === 'string' &&
    timingSafeEqual(digest(candidate), digest(expected))
  );
}

async function readSpec(): Promise<HostSpec> {
  return await new Promise<HostSpec>((resolve, reject) => {
    let bytes = 0;
    let input = '';

    const fail = (error: unknown) => {
      process.stdin.removeAllListeners();
      reject(error);
    };

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2_000_000) {
        fail(new Error('durable process host spec is too large'));
        return;
      }
      input += chunk;
      const newline = input.indexOf('\n');
      if (newline < 0) return;

      process.stdin.removeAllListeners();
      try {
        const spec = JSON.parse(input.slice(0, newline)) as HostSpec;
        if (
          spec.version !== 1 ||
          typeof spec.sessionId !== 'string' ||
          typeof spec.token !== 'string' ||
          typeof spec.address !== 'string' ||
          typeof spec.root !== 'string' ||
          typeof spec.executable !== 'string' ||
          !Array.isArray(spec.args) ||
          typeof spec.shell !== 'string' ||
          !Number.isInteger(spec.maxBufferBytes) ||
          spec.maxBufferBytes < 65_536 ||
          spec.maxBufferBytes > 16_777_216
        ) {
          throw new Error('invalid durable process host spec');
        }
        resolve(spec);
      } catch (error) {
        reject(error);
      }
    });
    process.stdin.once('error', fail);
    process.stdin.once('end', () => {
      if (!input.includes('\n')) {
        fail(new Error('durable process host spec ended before newline'));
      }
    });
  });
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
      // Process already exited.
    }
  }
}

function summary(spec: HostSpec, state: HostState) {
  return {
    sessionId: spec.sessionId,
    pid: state.child.pid ?? null,
    hostPid: process.pid,
    shell: spec.shell,
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    status: state.status,
    exitCode: state.exitCode,
    signal: state.signal,
    startedAt: state.startedAt,
    ...(state.exitedAt ? { exitedAt: state.exitedAt } : {}),
    oldestSeq: state.events[0]?.seq ?? state.nextSeq,
    latestSeq: state.nextSeq - 1,
    bufferedEvents: state.events.length,
    bufferedBytes: state.bufferedBytes,
    maxBufferBytes: spec.maxBufferBytes,
  };
}

async function persistMeta(
  spec: HostSpec,
  state: HostState,
): Promise<void> {
  const dir = path.join(spec.root, spec.sessionId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'meta.json');
  const temp = file + '.tmp';
  await fs.writeFile(
    temp,
    JSON.stringify(summary(spec, state), null, 2) + '\n',
    'utf8',
  );
  await fs.rename(temp, file);
}

function appendOutput(
  spec: HostSpec,
  state: HostState,
  stream: 'stdout' | 'stderr',
  chunk: Buffer,
): void {
  const text = chunk.toString('utf8');
  const event: OutputEvent = {
    seq: state.nextSeq++,
    stream,
    text,
    at: new Date().toISOString(),
  };
  state.events.push(event);
  state.bufferedBytes += Buffer.byteLength(text);

  while (
    state.bufferedBytes > spec.maxBufferBytes &&
    state.events.length > 1
  ) {
    const removed = state.events.shift();
    if (removed) {
      state.bufferedBytes -= Buffer.byteLength(removed.text);
    }
  }
}

function send(
  socket: Socket,
  value: unknown,
): void {
  socket.end(JSON.stringify(value) + '\n');
}

async function parseRequest(socket: Socket): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    let input = '';
    let bytes = 0;
    let settled = false;

    const finish = (
      error?: unknown,
      value?: Record<string, unknown>,
    ) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      if (error) reject(error);
      else resolve(value ?? {});
    };

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1_500_000) {
        finish(new Error('control request too large'));
        return;
      }
      input += chunk;
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      try {
        const decoded = JSON.parse(input.slice(0, newline));
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
          throw new Error('invalid control request');
        }
        finish(undefined, decoded as Record<string, unknown>);
      } catch (error) {
        finish(error);
      }
    });
    socket.once('error', finish);
  });
}

async function waitForExit(
  state: HostState,
  timeoutMs = 5_000,
): Promise<void> {
  if (state.status !== 'running') return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    state.child.once('close', finish);
    if (state.status !== 'running') finish();
  });
}

async function cleanupSocket(address: string): Promise<void> {
  if (process.platform === 'win32') return;
  await fs.rm(address, { force: true }).catch(() => undefined);
}

export async function runDurableProcessHost(): Promise<void> {
  const spec = await readSpec();
  await cleanupSocket(spec.address);

  const child = spawn(spec.executable, spec.args, {
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    windowsHide: true,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  const state: HostState = {
    child,
    status: 'running',
    exitCode: null,
    signal: null,
    startedAt: new Date().toISOString(),
    events: [],
    nextSeq: 1,
    bufferedBytes: 0,
  };

  child.stdout.on('data', (chunk: Buffer) =>
    appendOutput(spec, state, 'stdout', chunk),
  );
  child.stderr.on('data', (chunk: Buffer) =>
    appendOutput(spec, state, 'stderr', chunk),
  );
  child.once('error', (error) => {
    appendOutput(
      spec,
      state,
      'stderr',
      Buffer.from(`Process error: ${error.message}\n`),
    );
  });

  let server: Server;
  let exitCleanupTimer: NodeJS.Timeout | undefined;

  child.once('close', (code, signal) => {
    state.status = 'exited';
    state.exitCode = code;
    state.signal = signal;
    state.exitedAt = new Date().toISOString();
    void persistMeta(spec, state).catch(() => undefined);

    exitCleanupTimer = setTimeout(() => {
      server.close(() => {
        void cleanupSocket(spec.address).finally(() => process.exit(0));
      });
    }, 24 * 60 * 60 * 1000);
  });

  server = net.createServer((socket) => {
    void (async () => {
      try {
        const request = await parseRequest(socket);
        if (!tokenMatches(request.token, spec.token)) {
          send(socket, {
            ok: false,
            error: {
              code: 'DURABLE_PROCESS_UNAUTHORIZED',
              message: 'Invalid durable process control token.',
            },
          });
          return;
        }

        const op = request.op;
        if (op === 'summary') {
          send(socket, { ok: true, data: summary(spec, state) });
          return;
        }

        if (op === 'read') {
          const afterSeq =
            typeof request.afterSeq === 'number' &&
            Number.isInteger(request.afterSeq) &&
            request.afterSeq >= 0
              ? request.afterSeq
              : 0;
          const maxEvents =
            typeof request.maxEvents === 'number' &&
            Number.isInteger(request.maxEvents)
              ? Math.min(1000, Math.max(1, request.maxEvents))
              : 200;
          const waitMs =
            typeof request.waitMs === 'number' &&
            Number.isInteger(request.waitMs)
              ? Math.min(10_000, Math.max(0, request.waitMs))
              : 0;
          const deadline = Date.now() + waitMs;

          let events = state.events
            .filter((event) => event.seq > afterSeq)
            .slice(0, maxEvents);
          while (
            events.length === 0 &&
            state.status === 'running' &&
            Date.now() < deadline
          ) {
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                Math.min(50, Math.max(1, deadline - Date.now())),
              ),
            );
            events = state.events
              .filter((event) => event.seq > afterSeq)
              .slice(0, maxEvents);
          }

          send(socket, {
            ok: true,
            data: {
              session: summary(spec, state),
              events,
              nextSeq: events.at(-1)?.seq ?? afterSeq,
            },
          });
          return;
        }

        if (op === 'write') {
          if (
            state.status !== 'running' ||
            !state.child.stdin.writable
          ) {
            send(socket, {
              ok: false,
              error: {
                code: 'PROCESS_NOT_RUNNING',
                message: 'Durable process is not accepting input.',
              },
            });
            return;
          }

          const input =
            typeof request.input === 'string' ? request.input : '';
          if (Buffer.byteLength(input) > 1_048_576) {
            send(socket, {
              ok: false,
              error: {
                code: 'PROCESS_INPUT_TOO_LARGE',
                message: 'Durable process input exceeds the safety bound.',
              },
            });
            return;
          }
          const value =
            input + (request.appendNewline === true ? '\n' : '');
          await new Promise<void>((resolve, reject) =>
            state.child.stdin.write(value, (error) =>
              error ? reject(error) : resolve(),
            ),
          );
          send(socket, {
            ok: true,
            data: {
              session: summary(spec, state),
              bytes: Buffer.byteLength(value),
            },
          });
          return;
        }

        if (op === 'stop') {
          if (state.status === 'running' && state.child.pid) {
            await killPidTree(state.child.pid);
            await waitForExit(state);
          }
          send(socket, { ok: true, data: summary(spec, state) });
          return;
        }

        if (op === 'shutdown') {
          if (state.status === 'running') {
            send(socket, {
              ok: false,
              error: {
                code: 'DURABLE_PROCESS_STILL_RUNNING',
                message:
                  'Refusing to shut down a durable host while its child is running.',
              },
            });
            return;
          }

          if (exitCleanupTimer) clearTimeout(exitCleanupTimer);
          send(socket, { ok: true, data: summary(spec, state) });
          setTimeout(() => {
            server.close(() => {
              void cleanupSocket(spec.address).finally(() => process.exit(0));
            });
          }, 25);
          return;
        }

        send(socket, {
          ok: false,
          error: {
            code: 'DURABLE_PROCESS_BAD_REQUEST',
            message: 'Unknown durable process control operation.',
          },
        });
      } catch (error) {
        send(socket, {
          ok: false,
          error: {
            code: 'DURABLE_PROCESS_CONTROL_ERROR',
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(spec.address, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  await persistMeta(spec, state);
}
