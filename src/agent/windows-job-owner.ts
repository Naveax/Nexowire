import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verifyWindowsKernelJob } from './windows-job-kernel-attestation.js';
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

function candidateBinary(): string {
  // Source: src/agent -> native/. Bundle: dist/src/agent -> dist/native/.
  // Do not accept an environment-variable override or parent-directory
  // fallback. An attacker-controlled executable can forge an ownership marker.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, '../../native/windows-job-owner.exe');
}

interface HelperIdentity { digest: string; signature: string }

/**
 * Build-produced SHA detects helper-only substitution; release signer and
 * protected manifest provenance still require separate production acceptance.
 */
export async function verifyWindowsJobHelperBinary(helper: string): Promise<HelperIdentity> {
  try {
    const manifest = path.join(path.dirname(helper), 'windows-job-owner.sha256');
    const expected = (await fs.readFile(manifest, 'utf8')).trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('invalid SHA256 manifest');
    const dir = path.dirname(helper);
    const [dirLink, link, resolved, canonicalParent, first] = await Promise.all([
      fs.lstat(dir), fs.lstat(helper), fs.realpath(helper), fs.realpath(dir),
      fs.stat(helper, { bigint: true }),
    ]);
    // Windows may canonicalize a checkout's ancestor (drive/mount alias).
    // Compare canonical parent + leaf identity instead of the uncanonical
    // user-facing path. Never permit a symlink/junction at the selected
    // helper leaf or at its immediate parent.
    const sameParent = path.win32.normalize(path.win32.dirname(resolved)).toLowerCase() ===
      path.win32.normalize(canonicalParent).toLowerCase();
    const sameLeaf = path.win32.basename(resolved).toLowerCase() ===
      path.win32.basename(helper).toLowerCase();
    if (dirLink.isSymbolicLink() || link.isSymbolicLink() || !link.isFile() ||
        !sameParent || !sameLeaf) {
      throw new Error('helper path is a link or reparse redirection');
    }
    const handle = await fs.open(helper, 'r');
    let actual: string;
    try {
      actual = createHash('sha256').update(await handle.readFile()).digest('hex');
    } finally {
      await handle.close();
    }
    const second = await fs.stat(helper, { bigint: true });
    if (actual !== expected || first.dev !== second.dev ||
        first.ino !== second.ino || first.size !== second.size ||
        first.mtimeNs !== second.mtimeNs) {
      throw new Error('helper hash or file identity changed');
    }
    return { digest: actual,
      signature: [first.dev, first.ino, first.size, first.mtimeNs].join(':') };
  } catch (cause) {
    throw new WindowsJobOwnerError('WINDOWS_JOB_HELPER_UNTRUSTED',
      'Windows Job helper image/path integrity unverified: ' +
      (cause instanceof Error ? cause.message : String(cause)));
  }
}
async function binaryPath(): Promise<string> {
  const candidate = candidateBinary();
  await verifyWindowsJobHelperBinary(candidate);
  return candidate;
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
  const release = path.join(directory, 'verified.ok');
  let child: ChildProcessWithoutNullStreams | undefined;
  let verified = false;
  try {
    // Invoked by Node with pipes. Native helper forwards inherited std handles
    // to the suspended shell and owns the Job until every member is gone.
    child = spawn(
      helper,
      ['--status', marker, '--cwd', options.cwd ?? '-', '--parent',
        options.guardOnParentExit ? String(process.pid) : '0',
        '--release', release, '--', executable, ...args],
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
        const match = /^NWJOB5 ([1-9][0-9]*) ([1-9][0-9]*) ([1-9][0-9]*)$/.exec(line);
        if (!match) throw new Error('Invalid Windows Job attestation');
        const pid = Number(match[1]);
        if (!Number.isSafeInteger(pid) || pid > 0xffffffff) {
          throw new Error('Invalid owned Windows process ID');
        }
        // Never trust helper-authored marker text without an independent
        // Win32 kernel membership + job limit verification.
        if (!child.pid) throw new Error('Windows Job guardian PID unavailable');
        await verifyWindowsKernelJob(pid, match[2]!, child.pid, match[3]!);
        await verifyWindowsJobHelperBinary(helper);
        await fs.writeFile(release, 'verified', { flag: 'wx', mode: 0o600 });
        verified = true;
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
    const cleanup = () => { void fs.rm(directory, { recursive: true, force: true })
      .catch(() => undefined); };
    // Never remove the verification gate while the native guardian still
    // needs to observe it. Keep only this unique session's temp directory
    // until the guardian's close event, including normal long-running tasks.
    if (verified && child && child.exitCode === null && child.signalCode === null) {
      child.once('close', cleanup);
    } else {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
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
