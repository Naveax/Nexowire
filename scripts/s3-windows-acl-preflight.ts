/**
 * Read-only Windows ACL preflight. Explicitly guards the P0 #271 boundary:
 * protected owner alone is insufficient when Authenticated Users have
 * inherited Modify on an elevated executable/import tree.
 *
 * This is an operator-only inspection, NOT ACL remediation, and NEVER
 * authorizes execution or elevation. No live service/task mutation.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const SYSTEM32 = 'C:\\Windows\\System32';
const ALLOWED_OWNERS = new Set(['S-1-5-18', 'S-1-5-32-544']);
const MAX_NODES = 4096;
const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:\\/;
const DANGEROUS_MASK = (
  0x0002 | 0x0004 | 0x0010 | 0x0100 | 0x0040 | 0x10000 |
  0x40000 | 0x80000 | 0x10000000 | 0x40000000
);

export interface CapturedAclEntry {
  principalSid: string;
  kind: 'Allow' | 'Deny';
  fileSystemRights: number;
  inherited: boolean;
}
export interface CapturedAclNode {
  path: string;
  ownerSid: string;
  isReparsePoint: boolean;
  entries: CapturedAclEntry[];
}
export interface WindowsAclAudit {
  status: 'protected_tree_inspected';
  inspectedNodes: number;
  p0LegacyRuntimeExposed: false;
  /** Scanning cannot pin future execution bytes, handles or SIDs. */
  executionSafe: false;
  productionApproved: false;
}
export function evaluateCapturedAclNodes(
  nodes: readonly CapturedAclNode[],
): WindowsAclAudit {
  if (nodes.length === 0 || nodes.length > MAX_NODES) throw new Error('S3_ACL_NODE_COUNT');
  const seen = new Set<string>();
  for (const node of nodes) {
    if (!WINDOWS_DRIVE_PATH.test(node.path) ||
        !ALLOWED_OWNERS.has(node.ownerSid) ||
        node.isReparsePoint ||
        !Array.isArray(node.entries)) throw new Error('S3_ACL_UNTRUSTED_NODE');
    const normalized = path.win32.normalize(node.path).toLowerCase();
    if (seen.has(normalized)) throw new Error('S3_ACL_DUPLICATE_NODE');
    seen.add(normalized);
    // All Allow rules granting mutation to any non-SYSTEM/Admin principal
    // fail closed. Explicit DENY may coexist but does NOT prove rights are
    // actually denied after group/token expansion or privilege elevation.
    for (const ace of node.entries) {
      if (!/^S-\d+(?:-\d+)+$/.test(ace.principalSid) ||
          (ace.kind !== 'Allow' && ace.kind !== 'Deny') ||
          !Number.isSafeInteger(ace.fileSystemRights) ||
          !Number.isFinite(ace.fileSystemRights)) throw new Error('S3_ACL_BAD_ENTRY');
      if (ace.kind === 'Allow' && !ALLOWED_OWNERS.has(ace.principalSid) &&
          ((ace.fileSystemRights & DANGEROUS_MASK) !== 0)) {
        throw new Error('S3_ACL_UNTRUSTED_WRITER');
      }
    }
  }
  return {
    status: 'protected_tree_inspected',
    inspectedNodes: nodes.length,
    p0LegacyRuntimeExposed: false,
    executionSafe: false,
    productionApproved: false,
  };
}
function psQuote(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}
/**
 * Scan all drive-root-to-target ancestors plus every entry of the target
 * tree, with explicit bounded traversal. Do not follow reparse points.
 * PowerShell 5.1 is pinned by absolute OS path and sanitized environment.
 *
 * A non-admin can observe some ACLs but cannot certify SYSTEM's entire
 * future import graph or actual effective access. Always keep NO-GO.
 */
export function inspectWindowsProtectedExecutableTree(
  root: string,
  platform: NodeJS.Platform = process.platform,
): WindowsAclAudit {
  if (platform !== 'win32') throw new Error('S3_ACL_WINDOWS_REQUIRED');
  if (typeof root !== 'string' || root.length < 6 || root.length > 4096 ||
      !WINDOWS_DRIVE_PATH.test(root) || root.slice(2).includes(':') ||
      /[\u0000-\u001f]/.test(root)) throw new Error('S3_ACL_INVALID_PATH');

  const script = [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    '$root=' + psQuote(path.win32.normalize(root)),
    '$limit=' + MAX_NODES,
    '$seen=New-Object "System.Collections.Generic.HashSet[string]" ([StringComparer]::OrdinalIgnoreCase)',
    '$nodes=New-Object System.Collections.ArrayList',
    'function ReadNode([string]$p){',
    ' $full=[IO.Path]::GetFullPath($p)',
    ' if(-not $seen.Add($full)){return}',
    ' if($nodes.Count -ge $limit){throw "ACL_TOO_MANY"}',
    ' $item=Get-Item -LiteralPath $full -Force -ErrorAction Stop',
    ' $acl=Get-Acl -LiteralPath $full -ErrorAction Stop',
    ' try{$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value}catch{throw "ACL_UNKNOWN_OWNER"}',
    ' $entries=New-Object System.Collections.ArrayList',
    ' foreach($a in $acl.Access){',
    '  $sid=$a.IdentityReference',
    '  try{$sid=$sid.Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{throw "ACL_UNKNOWN_PRINCIPAL"}',
    '  [void]$entries.Add(@{principalSid=$sid;kind=[string]$a.AccessControlType;fileSystemRights=[long]$a.FileSystemRights;inherited=[bool]$a.IsInherited})',
    ' }',
    ' [void]$nodes.Add(@{path=$full;ownerSid=$owner;isReparsePoint=[bool](($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0);entries=@($entries.ToArray())})',
    '}',
    '$cursor=$root',
    'while($cursor){',
    ' ReadNode $cursor',
    ' $next=Split-Path -Path $cursor -Parent',
    ' if(-not $next -or $next -eq $cursor){break}',
    ' $cursor=$next',
    '}',
    // Enumerate bounded descendants, reject junctions even if PS does not
    // traverse them. Any list failure is NO-GO; no partial PASS.
    // Stream iteration so a maliciously huge directory cannot construct
    // an unbounded intermediate PowerShell file list before the node cap.
    'Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction Stop | ForEach-Object {ReadNode $_.FullName}',
    'Write-Output (ConvertTo-Json -InputObject @($nodes.ToArray()) -Compress -Depth 7)',
  ].join('\r\n');

  const result = spawnSync(POWERSHELL, [
    '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
    Buffer.from(script,'utf16le').toString('base64'),
  ], {
    cwd: SYSTEM32, shell: false, windowsHide: true,
    encoding:'utf8', timeout:25_000, maxBuffer:3*1024*1024,
    env:{
      SystemRoot:'C:\\Windows',windir:'C:\\Windows',
      PATH:'C:\\Windows\\System32;C:\\Windows',
      ComSpec:'C:\\Windows\\System32\\cmd.exe',
      PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
    },
  });
  if (result.error || result.status !== 0 || !result.stdout?.trim()) {
    throw new Error('S3_ACL_INSPECTION_UNAVAILABLE');
  }
  let nodes: unknown;
  try { nodes = JSON.parse(result.stdout); }
  catch { throw new Error('S3_ACL_INSPECTION_UNAVAILABLE'); }
  if (!Array.isArray(nodes)) throw new Error('S3_ACL_INSPECTION_UNAVAILABLE');
  return evaluateCapturedAclNodes(nodes as CapturedAclNode[]);
}
