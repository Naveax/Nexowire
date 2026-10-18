import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import * as z from 'zod';
import {assertNoObviousPrivateShellScriptBrokerInvocation} from './windows-private-shell-broker-guard.js';
import {assertWindowsPrivateWorkerDesktopIdentity} from './windows-private-worker-desktop-identity.js';
import {launchWindowsJob, requestWindowsJobStop, type WindowsJobLaunch} from './windows-job-owner.js';

const InitSchema = z.object({
  sessionId: z.string().uuid(),
  command: z.string().min(1).max(200_000),
  shell: z.enum(['pwsh', 'powershell', 'cmd', 'bash', 'sh']).optional(),
  cwd: z.string().max(4096).optional(),
  maxBufferBytes: z.number().int().min(65_536).max(16_777_216),
  token: z.string().min(32).max(256),
  // Only the limited, explicitly selected shell environment is forwarded
  // from a private Win32 desktop worker to its CLI child.
  executionEnv: z.record(z.string(),z.string().max(32_768)).optional(),
});

const ControlSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ping'),
    token: z.string().min(1),
  }),
  z.object({
    type: z.literal('write'),
    token: z.string().min(1),
    input: z.string().max(1_048_576),
    appendNewline: z.boolean().default(false),
    commandId: z.string().uuid().default(() => randomUUID()),
  }),
  z.object({
    type: z.literal('stop'),
    token: z.string().min(1),
    commandId: z.string().uuid().default(() => randomUUID()),
  }),
]);

interface WorkerEvent {
  seq: number;
  stream: 'stdout' | 'stderr';
  text: string;
  at: string;
}

interface WorkerStatus {
  version: 1;
  sessionId: string;
  workerPid: number;
  childPid: number | null;
  status: 'starting' | 'running' | 'exited';
  startedAt: string;
  exitedAt?: string;
  exitCode: number | null;
  signal: string | null;
  nextSeq: number;
  maxBufferBytes: number;
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
  shell: z.infer<typeof InitSchema>['shell'],
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
    throw new Error(`Shell ${shell} is unavailable on this platform.`);
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

function isTransientAtomicRenameError(error: unknown): boolean {
  return (
    process.platform === 'win32' &&
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ['EACCES', 'EBUSY', 'EPERM'].includes(String(error.code))
  );
}

async function atomicJson(
  file: string,
  value: unknown,
  mode?: number,
): Promise<void> {
  const temp = file + '.tmp';
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', {
    encoding: 'utf8',
    ...(mode !== undefined ? { mode } : {}),
  });

  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(temp, file);
      return;
    } catch (error) {
      if (
        attempt >= 7 ||
        !isTransientAtomicRenameError(error)
      ) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 25 * (attempt + 1)),
      );
    }
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
      // Already gone.
    }
  }
}

async function readInitialInput(sessionDir?: string): Promise<unknown> {
  // Used only for a private desktop worker whose stdin is unavailable to
  // CreateProcess. Init data is confined to the authenticated worker dir.
  if(sessionDir !== undefined){
    const file=path.join(sessionDir,'init.json');
    const raw=await fs.readFile(file,'utf8');
    const parsed=JSON.parse(raw) as unknown;
    await fs.rm(file,{force:true});
    return parsed;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(raw);
}

export async function runProcessWorker(
  sessionDir: string,
  fileInput = false,
): Promise<void> {
  const init = InitSchema.parse(await readInitialInput(fileInput?sessionDir:undefined));
  const shell = resolveShell(init.shell, init.command);
  // Private durable workers are a *second* trust boundary after the
  // ProcessManager preflight. Never trust only the parent's initial argv
  // audit: a worker can see different launch inputs after an update or
  // replay. Re-check before control sockets, status files, or child spawn.
  const hasPrivateEnv=init.executionEnv!==undefined;
  if(fileInput!==hasPrivateEnv){
    throw Object.assign(new Error(
      'Private worker file input and sanitized execution environment must agree.',
    ),{code:'PRIVATE_PROCESS_WORKER_INIT_MODE_MISMATCH'});
  }
  if(fileInput){
    if(process.platform!=='win32'){
      throw Object.assign(new Error(
        'Private desktop process workers require Windows.',
      ),{code:'PRIVATE_PROCESS_WINDOWS_ONLY'});
    }
    await assertNoObviousPrivateShellScriptBrokerInvocation(
      shell.executable,shell.args,init.cwd,
    );
    // The static command gate is not evidence of the actual desktop.
    // Probe a first-party child thread's Win32 desktop name before
    // opening the control listener or spawning the requested process.
    assertWindowsPrivateWorkerDesktopIdentity();
  }
  await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });

  const controlFile = path.join(sessionDir, 'control.json');
  const statusFile = path.join(sessionDir, 'status.json');
  const eventsFile = path.join(sessionDir, 'events.jsonl');

  const events: WorkerEvent[] = [];
  let bufferedBytes = 0;
  let nextSeq = 1;
  let persistChain: Promise<void> = Promise.resolve();
  let eventChain: Promise<void> = Promise.resolve();
  let child: ChildProcessWithoutNullStreams | undefined;
  let job: WindowsJobLaunch | undefined;
  const processedCommands = new Set<string>();
  const startedAt = new Date().toISOString();

  let status: WorkerStatus = {
    version: 1,
    sessionId: init.sessionId,
    workerPid: process.pid,
    childPid: null,
    status: 'starting',
    startedAt,
    exitCode: null,
    signal: null,
    nextSeq,
    maxBufferBytes: init.maxBufferBytes,
  };

  const persistStatus = async (): Promise<void> => {
    status = { ...status, nextSeq };
    persistChain = persistChain
      .catch(() => undefined)
      .then(() => atomicJson(statusFile, status, 0o600));
    await persistChain;
  };

  const rewriteEvents = async (): Promise<void> => {
    const body =
      events.map((event) => JSON.stringify(event)).join('\n') +
      (events.length > 0 ? '\n' : '');
    const temp = eventsFile + '.tmp';
    await fs.writeFile(temp, body, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, eventsFile);
  };

  const append = async (
    stream: 'stdout' | 'stderr',
    chunk: Buffer,
  ): Promise<void> => {
    eventChain = eventChain.catch(() => undefined).then(async () => {
      const event: WorkerEvent = {
        seq: nextSeq++,
        stream,
        text: chunk.toString('utf8'),
        at: new Date().toISOString(),
      };
      events.push(event);
      bufferedBytes += Buffer.byteLength(event.text);

      let trimmed = false;
      while (
        bufferedBytes > init.maxBufferBytes &&
        events.length > 1
      ) {
        const removed = events.shift();
        if (removed) {
          bufferedBytes -= Buffer.byteLength(removed.text);
          trimmed = true;
        }
      }

      if (trimmed) {
        await rewriteEvents();
      } else {
        await fs.appendFile(
          eventsFile,
          JSON.stringify(event) + '\n',
          { encoding: 'utf8', mode: 0o600 },
        );
      }
      await persistStatus();
    });
    await eventChain;
  };

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1_200_000) {
        socket.end(JSON.stringify({ ok: false, error: 'CONTROL_TOO_LARGE' }) + '\n');
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);

      void (async () => {
        try {
          const command = ControlSchema.parse(JSON.parse(line));
          if (command.token !== init.token) {
            socket.end(
              JSON.stringify({ ok: false, error: 'UNAUTHORIZED' }) + '\n',
            );
            return;
          }

          if (command.type === 'ping') {
            socket.end(
              JSON.stringify({
                ok: true,
                status: status.status,
                childPid: status.childPid,
              }) + '\n',
            );
            return;
          }

          if (processedCommands.has(command.commandId)) {
            socket.end(
              JSON.stringify({ ok: true, duplicate: true }) + '\n',
            );
            return;
          }
          processedCommands.add(command.commandId);
          if (processedCommands.size > 4096) {
            const first = processedCommands.values().next().value;
            if (first) processedCommands.delete(first);
          }

          if (command.type === 'write') {
            if (
              status.status !== 'running' ||
              !child ||
              !child.stdin.writable
            ) {
              socket.end(
                JSON.stringify({ ok: false, error: 'PROCESS_NOT_RUNNING' }) +
                  '\n',
              );
              return;
            }
            const value =
              command.input + (command.appendNewline ? '\n' : '');
            await new Promise<void>((resolve, reject) => {
              child!.stdin.write(value, (error) =>
                error ? reject(error) : resolve(),
              );
            });
            socket.end(
              JSON.stringify({
                ok: true,
                bytes: Buffer.byteLength(value),
              }) + '\n',
            );
            return;
          }

          if (command.type === 'stop') {
            if (status.status === 'running' && child) {
              if (job) {
                const cleanup = requestWindowsJobStop(job);
                if (cleanup !== 'requested') {
                  socket.end(JSON.stringify({ok:false,error:'PROCESS_TREE_TERMINATION_UNCONFIRMED'})+'\n');
                  return;
                }
                socket.end(JSON.stringify({ok:true,treeCleanup:cleanup})+'\n');
                return;
              }
              await killPidTree(child.pid!);
            }
            socket.end(JSON.stringify({ ok: true, treeCleanup: 'unconfirmed' }) + '\n');
          }
        } catch (error) {
          socket.end(
            JSON.stringify({
              ok: false,
              error:
                error instanceof Error ? error.message : String(error),
            }) + '\n',
          );
        }
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Durable process control server has no TCP address.');
  }

  await atomicJson(
    controlFile,
    {
      version: 1,
      sessionId: init.sessionId,
      port: address.port,
      token: init.token,
      workerPid: process.pid,
      createdAt: startedAt,
    },
    0o600,
  );
  await fs.writeFile(eventsFile, '', { encoding: 'utf8', mode: 0o600 });
  await persistStatus();

  // Only ordinary headless durable workers can inherit this guardian's
  // stdout/stderr/console. Private-desktop launch is a distinct Win32 boundary
  // and is intentionally not represented as Job-contained here.
  if (process.platform === 'win32' && !fileInput) {
    job = await launchWindowsJob(shell.executable, shell.args,
      {cwd: init.cwd, env: process.env});
  }
  child = job?.child ?? spawn(shell.executable, shell.args, {
    ...(init.cwd ? { cwd: init.cwd } : {}),
    windowsHide: true,
    env: init.executionEnv ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  status = {
    ...status,
    childPid: job?.pid ?? child.pid ?? null,
    status: 'running',
  };
  await persistStatus();

  child.stdout.on('data', (chunk: Buffer) => {
    void append('stdout', chunk).catch(() => undefined);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    void append('stderr', chunk).catch(() => undefined);
  });
  child.once('error', (error) => {
    void append(
      'stderr',
      Buffer.from(`Process error: ${error.message}\n`),
    ).catch(() => undefined);
  });

  await new Promise<void>((resolve) => {
    child!.once('close', async (code, signal) => {
      await eventChain.catch(() => undefined);
      status = {
        ...status,
        status: 'exited',
        exitCode: code,
        signal,
        exitedAt: new Date().toISOString(),
      };
      await persistStatus().catch(() => undefined);
      resolve();
    });
  });

  server.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
}
