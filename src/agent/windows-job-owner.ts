import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Windows does not expose CREATE_SUSPENDED or Win32 Job Objects through
 * node:child_process. A small native, non-inheriting Job handle owner is the
 * containment boundary. Never treat a naked Node spawn as equivalent.
 */
export class WindowsJobOwnerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'WindowsJobOwnerError';
  }
}

export interface WindowsJobLaunch {
  child: ChildProcessWithoutNullStreams; // native guardian, NOT the shell PID
  pid: number; // suspended, assigned and resumed shell PID
  creationFiletime: string; // Win32 FILETIME ticks from GetProcessTimes
  guardianPid: number;
  closed: () => boolean;
}

function candidateBinaries(): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    ...(process.env.NEXOWIRE_WINDOWS_JOB_HELPER
      ? [process.env.NEXOWIRE_WINDOWS_JOB_HELPER]
      : []),
    path.resolve(moduleDir, '../../native/windows-job-owner.exe'),
    path.resolve(moduleDir, '../../../native/windows-job-owner.exe'),
  ];
}

async function binaryPath(): Promise<string> {
  for (const candidate of candidateBinaries()) {
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // Next supported deployment location.
    }
  }
  throw new WindowsJobOwnerError(
    'WINDOWS_JOB_HELPER_UNAVAILABLE',
    'Windows Job owner executable is missing. Refusing unmanaged process launch.',
  );
}

export async function launchWindowsJob(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; guardOnParentExit?: boolean }
): Promise<WindowsJobLaunch> {
  if (process.platform !== 'win32') {
    throw new WindowsJobOwnerError('WINDOWS_JOB_WINDOWS_ONLY', 'Windows only');
  }
  const helper = await binaryPath();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-job-'));
  const marker = path.join(directory, 'assigned.txt');
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    // Invoked by Node with pipes. Native helper forwards inherited std handles
    // to the suspended shell and owns the Job until every member is gone.
    child = spawn(
      helper,
      ['--status', marker, '--cwd', options.cwd ?? '-', '--parent',
        options.guardOnParentExit ? String(process.pid) : '0', '--', executable, ...args],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: options.env ?? process.env },
    );
    let failed: Error | undefined;
    let closed = false;
    child.once('error', (error) => { failed = error; });
    child.once('close', () => { closed = true; });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (failed) throw failed;
      try {
        const line = (await fs.readFile(marker, 'utf8')).trim();
        const match = /^NWJOB3 ([1-9][0-9]*) ([1-9][0-9]*)$/.exec(line);
        if (!match) throw new Error('Invalid Windows Job attestation');
        const pid = Number(match[1]);
        if (!Number.isSafeInteger(pid) || pid > 0xffffffff) {
          throw new Error('Invalid owned Windows process ID');
        }
        return {
          child, pid, creationFiletime: match[2]!,
          guardianPid: child.pid ?? 0, closed: () => closed,
        };
      } catch (error) {
        if (!(typeof error === 'object' && error !== null &&
            'code' in error && ['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(String(error.code)))) {
          throw error;
        }
      }
      if (closed || child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new WindowsJobOwnerError(
      'WINDOWS_JOB_LAUNCH_UNCONFIRMED',
      'Windows Job owner exited or timed out before confirming suspended-process assignment.',
    );
  } catch (error) {
    // Kill ONLY the freshly spawned guardian. Its non-inheritable Job handle
    // closes on death, ensuring an already-assigned child cannot escape.
    if (child && child.exitCode === null) child.kill();
    throw error;
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function requestWindowsJobStop(launch: WindowsJobLaunch): 'requested' | 'unconfirmed' {
  // Native guardian exit closes the sole Job handle (KILL_ON_JOB_CLOSE).
  // Requested is deliberately not a claim of independently verified tree death.
  if (launch.closed()) return 'unconfirmed';
  try {
    return launch.child.kill() ? 'requested' : 'unconfirmed';
  } catch {
    return 'unconfirmed';
  }
}
