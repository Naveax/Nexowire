import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';
import { windowsDpapiChildEnvironment } from '../security/windows-dpapi.js';
import {
  ScopedPathGrantRegistry,
  isRemovableVolume,
  resolveWindowsVolumeIdentity,
  sameVolume,
  unsafeWindowsPath,
  type FileScope,
  type VolumeIdentity,
  type VolumeResolver,
} from './scoped-path-grants.js';

const ScopeSchema = z.enum([
  'read', 'write', 'delete', 'move', 'recursive_delete', 'usb_write',
]);
const RequestSchema = z.object({
  path: z.string().min(1).max(4096),
  scopes: z.array(ScopeSchema).min(1).max(6),
  duration_minutes: z.number().int().min(1).max(1440).default(5),
  reason: z.string().trim().max(240).optional(),
}).strict();
const RevokeSchema = z.object({ grant_id: z.string().uuid() }).strict();
const GUID = /^\\\\\?\\Volume\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}\\$/i;

export class ScopedGrantApprovalError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ScopedGrantApprovalError';
  }
}

export type GrantApprovalProvider = (details: {
  root: string;
  scopes: readonly FileScope[];
  durationMinutes: number;
  reason: string | null;
  volumeId: string;
  deviceId: string;
  timeoutMs: number;
}) => Promise<boolean>;

const approvalScript = String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class NexowireConsoleSession {
  [DllImport("kernel32.dll")]
  public static extern uint WTSGetActiveConsoleSessionId();
}
'@
$active=[NexowireConsoleSession]::WTSGetActiveConsoleSessionId()
$current=[System.Diagnostics.Process]::GetCurrentProcess().SessionId
if($active -eq [uint32]::MaxValue -or $current -ne $active -or $current -eq 0) {
  throw 'PHYSICAL_CONSOLE_SESSION_REQUIRED'
}
Add-Type -AssemblyName System.Windows.Forms
$inputData=[Console]::In.ReadToEnd() | ConvertFrom-Json
$msg="A remote request asks for filesystem permissions on this PC."+
  [Environment]::NewLine+[Environment]::NewLine+
  "Folder: "+[string]$inputData.root+[Environment]::NewLine+
  "Scopes: "+([string[]]$inputData.scopes -join ', ')+[Environment]::NewLine+
  "Duration: "+[string]$inputData.durationMinutes+" minutes"+[Environment]::NewLine+
  "Volume GUID: "+[string]$inputData.volumeId+[Environment]::NewLine+
  "Disk identity: "+[string]$inputData.deviceId+[Environment]::NewLine+
  "Reason: "+[string]$inputData.reason+[Environment]::NewLine+[Environment]::NewLine+
  "DENY unless you recognize this request. There is no silent FULL ACCESS override."
$r=[System.Windows.Forms.MessageBox]::Show($msg,'Nexowire: Scoped Disk Permission',
   [System.Windows.Forms.MessageBoxButtons]::YesNo,
   [System.Windows.Forms.MessageBoxIcon]::Warning,
   [System.Windows.Forms.MessageBoxDefaultButton]::Button2)
@{approved=($r -eq [System.Windows.Forms.DialogResult]::Yes)} | ConvertTo-Json -Compress
`;

async function realGrantApproval(details: Parameters<GrantApprovalProvider>[0]): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  return await new Promise<boolean>((resolve, reject) => {
    const child = spawn(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', approvalScript],
      { cwd: 'C:\\Windows\\System32', env: windowsDpapiChildEnvironment(),
        // Never expose a PowerShell terminal; only the local consent dialog.
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', b => out.push(b));
    child.stderr.on('data', b => err.push(b));
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) { settled = true; resolve(false); }
    }, details.timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(error); }
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new ScopedGrantApprovalError(
          'PHYSICAL_CONSOLE_APPROVAL_UNAVAILABLE',
          'Local console approval was unavailable or failed closed.',
          { exitCode: code, category: 'local_console_unavailable' },
        ));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(out).toString('utf8').trim()).approved === true);
      } catch {
        reject(new ScopedGrantApprovalError('PHYSICAL_CONSOLE_OUTPUT_INVALID',
          'Unverifiable physical console answer.'));
      }
    });
    child.stdin.end(JSON.stringify(details));
  });
}

// Canonicalization alone is not atomic. Deny roots containing symlink/junction
// ancestors to reduce but NOT eliminate reparse/TOCTOU races.
async function assertNoReparseAncestors(root: string): Promise<void> {
  let cursor = path.resolve(root);
  for (;;) {
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink()) {
      throw new ScopedGrantApprovalError('REPARSE_ROOT_DENIED',
        'Grant path contains a symlink or junction.');
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

export class ScopedPathGrantAuthority {
  private pending = false;
  private lastPromptAt = 0;
  constructor(
    private readonly registry: ScopedPathGrantRegistry,
    private readonly ownerId: string,
    private readonly agentDeviceId: string,
    private readonly options: {
      platform?: NodeJS.Platform;
      resolveVolume?: VolumeResolver;
      approve?: GrantApprovalProvider;
      now?: () => number;
    } = {},
  ) {}

  status() {
    return { active: this.registry.active(this.ownerId, this.agentDeviceId) };
  }

  revoke(input: unknown) {
    const { grant_id } = RevokeSchema.parse(input);
    return { revoked: this.registry.revoke(grant_id),
      active: this.registry.active(this.ownerId, this.agentDeviceId).length };
  }

  async request(input: unknown) {
    const request = RequestSchema.parse(input);
    if ((this.options.platform ?? process.platform) !== 'win32') {
      throw new ScopedGrantApprovalError('WINDOWS_REQUIRED',
        'Physical scoped-grant issuance requires an interactive Windows console.');
    }
    if (!path.win32.isAbsolute(request.path) || unsafeWindowsPath(request.path)) {
      throw new ScopedGrantApprovalError('GRANT_ROOT_INVALID', 'Unsafe grant root.');
    }
    const scopes = [...new Set(request.scopes)];
    const destructive = scopes.includes('usb_write') || scopes.includes('recursive_delete');
    if (destructive && request.duration_minutes > 15) {
      throw new ScopedGrantApprovalError('GRANT_DURATION_EXCEEDED',
        'USB write or recursive-delete permissions last at most 15 minutes.');
    }
    if (this.pending) throw new ScopedGrantApprovalError('GRANT_PROMPT_ACTIVE',
      'A grant approval dialog is already pending.');
    const now = this.options.now ?? Date.now;
    if (now() - this.lastPromptAt < 5_000) {
      throw new ScopedGrantApprovalError('GRANT_PROMPT_COOLDOWN', 'Approval prompt cooldown.');
    }
    this.pending = true;
    this.lastPromptAt = now();
    try {
      const canonicalRoot = await fs.realpath(request.path);
      if (!(await fs.stat(canonicalRoot)).isDirectory() ||
          canonicalRoot === path.parse(canonicalRoot).root) {
        throw new ScopedGrantApprovalError('GRANT_ROOT_INVALID',
          'Grant must target an existing subdirectory, not a volume root.');
      }
      await assertNoReparseAncestors(request.path);
      const resolver = this.options.resolveVolume ?? resolveWindowsVolumeIdentity;
      const before = await resolver(canonicalRoot);
      if (!before || !GUID.test(before.volumeId) ||
          !before.deviceId || !Number.isSafeInteger(before.partitionNumber)) {
        throw new ScopedGrantApprovalError('VOLUME_IDENTITY_UNAVAILABLE',
          'Verified Volume GUID, disk and partition identities are required.');
      }
      if (scopes.includes('usb_write') && !isRemovableVolume(before)) {
        throw new ScopedGrantApprovalError('USB_VOLUME_REQUIRED',
          'USB write permission must target verified removable media.');
      }
      // No default/full-access shortcut. The production provider always
      // displays an interactive, target-specific dialog or denies.
      const approved = await (this.options.approve ?? realGrantApproval)({
        root: canonicalRoot,
        scopes,
        durationMinutes: request.duration_minutes,
        reason: request.reason ?? null,
        volumeId: before.volumeId,
        deviceId: before.deviceId,
        timeoutMs: 90_000,
      });
      if (!approved) return { approved: false, grantId: null };
      const canonicalAfter = await fs.realpath(request.path);
      await assertNoReparseAncestors(request.path);
      const after = await resolver(canonicalAfter);
      if (canonicalAfter !== canonicalRoot ||
          !after || !sameVolume(before, after) ||
          isRemovableVolume(before) !== isRemovableVolume(after)) {
        throw new ScopedGrantApprovalError('VOLUME_CHANGED_DURING_APPROVAL',
          'The path or disk identity changed while the grant dialog was open.');
      }
      const id = randomUUID();
      this.registry.grantLocally({
        id,
        root: canonicalRoot,
        ownerId: this.ownerId,
        deviceId: this.agentDeviceId,
        scopes,
        expiresAt: now() + request.duration_minutes * 60_000,
        volume: { volumeId: after.volumeId, deviceId: after.deviceId,
          partitionNumber: after.partitionNumber },
      });
      return { approved: true, grantId: id, root: canonicalRoot, scopes,
        expiresAt: new Date(now() + request.duration_minutes * 60_000).toISOString() };
    } finally {
      this.pending = false;
    }
  }
}
