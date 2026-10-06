import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import os from 'node:os';

/**
 * OS-owned Windows named-pipe lease. The kernel releases it even when the
 * agent is forcibly terminated, unlike a stale PID/lockfile sentinel.
 * Never accept control commands or secrets on the pipe.
 */
export interface NativeAgentSingletonLock {
  close(): Promise<void>;
}

export async function acquireNativeAgentSingleton(
  deviceId: string,
  options: { platform?: NodeJS.Platform; homeDir?: string } = {},
): Promise<NativeAgentSingletonLock | null> {
  if ((options.platform ?? process.platform) !== 'win32') return null;
  if (!deviceId.trim()) throw new Error('AGENT_IDENTITY_REQUIRED');

  // Include the current Windows user's home as well as the stable device ID.
  // No raw identity or username appears in the IPC name.
  const hash = createHash('sha256')
    .update('nexowire-agent-singleton-v1\\0')
    .update(options.homeDir ?? os.homedir())
    .update('\\0')
    .update(deviceId)
    .digest('hex')
    .slice(0, 32);
  const pipeName = "\\\\.\\pipe\\nexowire-agent-" + hash;
  const server = createServer((socket) => socket.destroy());

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once('error', onError);
      server.listen(pipeName, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(
        'AGENT_ALREADY_RUNNING: A Nexowire native agent for this Windows ' +
        'user/device is already active.',
      );
    }
    throw error;
  }

  // A lost lease must never go unnoticed while another agent might start.
  server.on('error', () => { process.exit(1); });
  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
