import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DurableProcessSummary {
  sessionId: string;
  pid: number | null;
  hostPid: number;
  shell: string;
  cwd?: string;
  status: 'running' | 'exited';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  exitedAt?: string;
  oldestSeq: number;
  latestSeq: number;
  bufferedEvents: number;
  bufferedBytes: number;
  maxBufferBytes: number;
}

export interface DurableProcessOutputEvent {
  seq: number;
  stream: 'stdout' | 'stderr';
  text: string;
  at: string;
}

interface DurableControlFile {
  version: 1;
  token: string;
}

interface RpcResponse {
  ok: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export class DurableProcessClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DurableProcessClientError';
  }
}

function sessionDir(root: string, sessionId: string): string {
  return path.join(root, sessionId);
}

export function durableMetaFile(
  root: string,
  sessionId: string,
): string {
  return path.join(sessionDir(root, sessionId), 'meta.json');
}

function controlFile(root: string, sessionId: string): string {
  return path.join(sessionDir(root, sessionId), 'control.json');
}

export function durableControlAddress(
  root: string,
  sessionId: string,
): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\nexowire-process-${sessionId}`;
  }
  return path.join(sessionDir(root, sessionId), 'control.sock');
}

function hostEntry(): { executable: string; args: string[] } {
  const current = fileURLToPath(import.meta.url);
  const dir = path.dirname(current);
  if (current.endsWith('.ts')) {
    return {
      executable: process.execPath,
      args: [
        '--import',
        'tsx',
        path.join(dir, 'durable-process-host-entry.ts'),
      ],
    };
  }
  return {
    executable: process.execPath,
    args: [path.join(dir, 'durable-process-host-entry.js')],
  };
}

async function writeControlFile(
  root: string,
  sessionId: string,
  token: string,
): Promise<void> {
  const dir = sessionDir(root, sessionId);
  await fs.mkdir(dir, { recursive: true });
  const file = controlFile(root, sessionId);
  const temp = file + '.tmp';
  const payload: DurableControlFile = { version: 1, token };
  await fs.writeFile(
    temp,
    JSON.stringify(payload) + '\n',
    process.platform === 'win32'
      ? { encoding: 'utf8' }
      : { encoding: 'utf8', mode: 0o600 },
  );
  await fs.rename(temp, file);
  if (process.platform !== 'win32') {
    await fs.chmod(file, 0o600);
  }
}

async function readControlToken(
  root: string,
  sessionId: string,
): Promise<string> {
  const decoded = JSON.parse(
    await fs.readFile(controlFile(root, sessionId), 'utf8'),
  ) as DurableControlFile;
  if (
    decoded.version !== 1 ||
    typeof decoded.token !== 'string' ||
    decoded.token.length < 32
  ) {
    throw new DurableProcessClientError(
      'DURABLE_PROCESS_CONTROL_INVALID',
      'Durable process control file is invalid.',
    );
  }
  return decoded.token;
}

export async function readDurableMeta(
  root: string,
  sessionId: string,
): Promise<DurableProcessSummary | null> {
  try {
    const decoded = JSON.parse(
      await fs.readFile(durableMetaFile(root, sessionId), 'utf8'),
    ) as DurableProcessSummary;
    if (
      decoded.sessionId !== sessionId ||
      typeof decoded.hostPid !== 'number' ||
      !['running', 'exited'].includes(decoded.status)
    ) {
      throw new Error('invalid durable process metadata');
    }
    return decoded;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}

export async function startDurableProcess(input: {
  root: string;
  sessionId: string;
  executable: string;
  args: string[];
  shell: string;
  cwd?: string;
  maxBufferBytes: number;
}): Promise<DurableProcessSummary> {
  const token = randomBytes(32).toString('hex');
  await writeControlFile(input.root, input.sessionId, token);
  const address = durableControlAddress(input.root, input.sessionId);
  const entry = hostEntry();
  const host = spawn(entry.executable, entry.args, {
    detached: true,
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  let stderr = '';
  host.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length >= 8192) return;
    stderr += chunk.toString('utf8').slice(0, 8192 - stderr.length);
  });

  const spec = {
    version: 1,
    sessionId: input.sessionId,
    token,
    address,
    root: input.root,
    executable: input.executable,
    args: input.args,
    shell: input.shell,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    maxBufferBytes: input.maxBufferBytes,
  };
  host.stdin.end(JSON.stringify(spec) + '\n');

  const deadline = Date.now() + 10_000;
  try {
    while (Date.now() < deadline) {
      const meta = await readDurableMeta(input.root, input.sessionId);
      if (meta) {
        host.stderr.destroy();
        host.unref();
        return meta;
      }
      if (host.exitCode !== null) {
        throw new DurableProcessClientError(
          'DURABLE_PROCESS_HOST_START_FAILED',
          `Durable process host exited before readiness (code ${host.exitCode}). ${stderr.trim()}`.trim(),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  } catch (error) {
    host.kill();
    throw error;
  }

  host.kill();
  throw new DurableProcessClientError(
    'DURABLE_PROCESS_HOST_START_TIMEOUT',
    `Timed out waiting for durable process host readiness. ${stderr.trim()}`.trim(),
  );
}

export async function durableProcessRpc<T>(
  root: string,
  sessionId: string,
  request: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<T> {
  const token = await readControlToken(root, sessionId);
  const address = durableControlAddress(root, sessionId);

  return await new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(address);
    let settled = false;
    let bytes = 0;
    let response = '';

    const finish = (error?: unknown, data?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(data as T);
    };

    const timer = setTimeout(() => {
      finish(
        new DurableProcessClientError(
          'DURABLE_PROCESS_RPC_TIMEOUT',
          'Durable process control request timed out.',
        ),
      );
    }, timeoutMs);

    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(JSON.stringify({ ...request, token }) + '\n');
    });
    socket.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 20_000_000) {
        finish(
          new DurableProcessClientError(
            'DURABLE_PROCESS_RESPONSE_TOO_LARGE',
            'Durable process response exceeded the local safety bound.',
          ),
        );
        return;
      }
      response += chunk;
      const newline = response.indexOf('\n');
      if (newline < 0) return;

      let decoded: RpcResponse;
      try {
        decoded = JSON.parse(response.slice(0, newline)) as RpcResponse;
      } catch {
        finish(
          new DurableProcessClientError(
            'DURABLE_PROCESS_RESPONSE_INVALID',
            'Durable process host returned invalid JSON.',
          ),
        );
        return;
      }

      if (!decoded.ok) {
        finish(
          new DurableProcessClientError(
            decoded.error?.code ?? 'DURABLE_PROCESS_ERROR',
            decoded.error?.message ??
              'Durable process host rejected the control request.',
          ),
        );
        return;
      }
      finish(undefined, decoded.data as T);
    });
    socket.once('error', (error) => {
      finish(
        new DurableProcessClientError(
          'DURABLE_PROCESS_UNAVAILABLE',
          error instanceof Error ? error.message : String(error),
        ),
      );
    });
  });
}

export async function removeDurableSessionFiles(
  root: string,
  sessionId: string,
): Promise<void> {
  await fs.rm(sessionDir(root, sessionId), {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 50,
  });
}
