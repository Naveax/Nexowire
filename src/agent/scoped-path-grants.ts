import { execFile } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type FileScope =
  | 'read' | 'write' | 'delete' | 'move' | 'recursive_delete' | 'usb_write';

export interface VolumeIdentity {
  driveLetter: string;
  volumeId: string;
  deviceId: string;
  busType: string;
  driveType: string;
  partitionNumber: number;
}

export type VolumeResolver = (target: string) => Promise<VolumeIdentity | null>;

export interface ScopedPathGrant {
  id: string;
  ownerId: string;
  deviceId: string;
  root: string;
  scopes: readonly FileScope[];
  expiresAt: number;
  // Required for USB/removable volumes. Bound to volume AND device, never the letter.
  volume?: Pick<VolumeIdentity, 'volumeId' | 'deviceId' | 'partitionNumber'>;
}

const SCOPES = new Set<FileScope>([
  'read', 'write', 'delete', 'move', 'recursive_delete', 'usb_write',
]);
const MAX_GRANT_MS = 24 * 60 * 60 * 1000;
const MAX_DESTRUCTIVE_GRANT_MS = 15 * 60 * 1000;

/**
 * Owner-approved grants are minted on the device, not through remote file/shell
 * capabilities. This is intentionally in-memory and fail-closed on agent restart:
 * loading arbitrary JSON from an agent-writable path would permit grant forgery.
 */
export class ScopedPathGrantRegistry {
  private readonly grants = new Map<string, ScopedPathGrant>();
  private readonly monotonicDeadlines = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {}

  grantLocally(grant: ScopedPathGrant): void {
    if (this.grants.has(grant.id)) {
      throw new Error('Grant ID already exists; revoke explicitly before any replacement.');
    }
    const remaining = grant.expiresAt - this.now();
    const destructive = grant.scopes.includes('usb_write') ||
      grant.scopes.includes('recursive_delete');
    const maxDuration = destructive ? MAX_DESTRUCTIVE_GRANT_MS : MAX_GRANT_MS;
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(grant.id) ||
        !grant.ownerId.trim() || !grant.deviceId.trim() ||
        !path.isAbsolute(grant.root) ||
        !grant.scopes.length || grant.scopes.some(scope => !SCOPES.has(scope)) ||
        !Number.isFinite(remaining) || remaining <= 0 || remaining > maxDuration) {
      throw new Error('Invalid locally-approved scoped path grant.');
    }
    if (process.platform === 'win32' && unsafeWindowsPath(grant.root)) {
      throw new Error('Unsafe Windows namespace in scoped grant root.');
    }
    if (destructive && path.resolve(grant.root) === path.parse(grant.root).root) {
      throw new Error('Destructive permissions cannot target an entire volume root.');
    }
    if (grant.scopes.includes('usb_write') && !grant.volume) {
      throw new Error('USB write grants require verified volume identity.');
    }
    if (grant.volume &&
        (!grant.volume.volumeId || !grant.volume.deviceId ||
         !Number.isSafeInteger(grant.volume.partitionNumber))) {
      throw new Error('A volume grant requires stable volume, disk and partition identifiers.');
    }
    const deadline = this.monotonicNow() + remaining;
    if (!Number.isFinite(deadline)) throw new Error('Invalid monotonic grant expiry.');
    this.grants.set(grant.id, {
      ...grant,
      root: path.resolve(grant.root),
      scopes: [...new Set(grant.scopes)],
      ...(grant.volume ? { volume: { ...grant.volume } } : {}),
    });
    this.monotonicDeadlines.set(grant.id, deadline);
  }

  revoke(id: string): boolean {
    this.monotonicDeadlines.delete(id);
    return this.grants.delete(id);
  }

  active(ownerId: string, deviceId: string): ScopedPathGrant[] {
    const wallNow = this.now();
    const steadyNow = this.monotonicNow();
    for (const grant of this.grants.values()) {
      if (grant.expiresAt <= wallNow ||
          (this.monotonicDeadlines.get(grant.id) ?? 0) <= steadyNow) {
        this.revoke(grant.id);
      }
    }
    return [...this.grants.values()].filter(grant =>
      grant.ownerId === ownerId && grant.deviceId === deviceId,
    ).map(grant => ({
      ...grant,
      scopes: [...grant.scopes],
      ...(grant.volume ? { volume: { ...grant.volume } } : {}),
    }));
  }

  authorizes(
    candidate: string,
    scope: FileScope,
    ownerId: string,
    deviceId: string,
    volume?: VolumeIdentity | null,
  ): boolean {
    return this.active(ownerId, deviceId).some(grant => {
      if (!grant.scopes.includes(scope) ||
          !withinRoot(candidate, mapVolumeGrantRoot(grant, candidate))) return false;
      if (grant.volume) {
        return volume !== null && volume !== undefined &&
          sameVolume(grant.volume, volume);
      }
      // A path-only grant can never authorize writes to USB media.
      return scope !== 'usb_write';
    });
  }
}

/** Resolve a volume grant's subdirectory after a drive-letter reassignment.
 * Identity is verified separately before such a mapped path is authorized.
 */
export function mapVolumeGrantRoot(grant: ScopedPathGrant, candidate: string): string {
  if (!grant.volume || process.platform !== 'win32') return grant.root;
  const original = path.win32.parse(grant.root).root;
  const current = path.win32.parse(candidate).root;
  if (!/^[A-Za-z]:\\$/.test(original) || !/^[A-Za-z]:\\$/.test(current))
    return grant.root;
  return path.win32.join(current, path.win32.relative(original, grant.root));
}

export function withinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' &&
    !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

export function sameVolume(
  expected: Pick<VolumeIdentity, 'volumeId' | 'deviceId' | 'partitionNumber'>,
  actual: VolumeIdentity,
): boolean {
  return expected.volumeId.toLowerCase() === actual.volumeId.toLowerCase() &&
    expected.deviceId.toLowerCase() === actual.deviceId.toLowerCase() &&
    expected.partitionNumber === actual.partitionNumber;
}

export function isRemovableVolume(volume: VolumeIdentity): boolean {
  return volume.busType.toLowerCase() === 'usb' ||
    volume.driveType.toLowerCase() === 'removable';
}

export function unsafeWindowsPath(requested: string): string | null {
  // Deny device namespaces, UNC (including WSL shares), DOS device paths and
  // drive-relative syntax before path.resolve() has a chance to disguise them.
  const p = requested.replace(/\//g, '\\');
  if (/^\\\\[.?]\\/i.test(p)) return 'WINDOWS_DEVICE_NAMESPACE';
  if (p.startsWith('\\\\')) return 'UNC_PATH_REQUIRES_SEPARATE_POLICY';
  if (/^[a-z]:($|[^\\])/i.test(p)) return 'DRIVE_RELATIVE_PATH';
  if (p.replace(/^[a-z]:/i, '').includes(':')) return 'ALTERNATE_DATA_STREAM_DENIED';
  if (p.split('\\').some(component =>
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(component)))
    return 'DOS_DEVICE_NAME_DENIED';
  if (/^(?:\\\\|\\)(?:GLOBALROOT|Device|DosDevices)(?:\\|$)/i.test(p))
    return 'WINDOWS_DEVICE_NAMESPACE';
  return null;
}

export async function resolveWindowsVolumeIdentity(
  target: string,
): Promise<VolumeIdentity | null> {
  if (process.platform !== 'win32') return null;
  const drive = path.win32.parse(target).root.match(/^([A-Za-z]):\\$/)?.[1];
  if (!drive) return null;
  // Only a verified drive letter is interpolated, never user-provided shell.
  const letter = drive.toUpperCase();
  const script = [
    "$ErrorActionPreference='Stop'",
    "$p=Get-Partition -DriveLetter '" + letter + "' -ErrorAction Stop",
    "$d=$p | Get-Disk -ErrorAction Stop",
    "$v=Get-Volume -DriveLetter '" + letter + "' -ErrorAction Stop",
    "if(!$p -or !$d -or !$v){throw 'Volume not available'}",
    "[pscustomobject]@{driveLetter='" + letter +
      "';volumeId=[string]$v.UniqueId;deviceId=[string]$d.UniqueId;" +
      "busType=[string]$d.BusType;driveType=[string]$v.DriveType;" +
      "partitionNumber=[int]$p.PartitionNumber} | ConvertTo-Json -Compress",
  ].join('; ');
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', script,
  ], { windowsHide: true, timeout: 10_000, maxBuffer: 16_384 });
  const candidate: unknown = JSON.parse(stdout.trim());
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('Unverifiable volume identity.');
  }
  const c = candidate as Record<string, unknown>;
  if (c.driveLetter !== letter || typeof c.volumeId !== 'string' ||
      !c.volumeId || typeof c.deviceId !== 'string' || !c.deviceId ||
      typeof c.busType !== 'string' || typeof c.driveType !== 'string' ||
      !Number.isSafeInteger(c.partitionNumber)) {
    throw new Error('Incomplete Windows volume identity.');
  }
  return c as unknown as VolumeIdentity;
}
