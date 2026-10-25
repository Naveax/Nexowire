/**
 * Read-only native Windows Authenticode evidence. This is NOT permission to
 * install/run a file. The release transport and installer still need a
 * separately trusted Nexowire-owned signing certificate and TOCTOU-safe
 * protected deployment transaction.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const WINDOWS_SYSTEM32 = 'C:\\Windows\\System32';
const SHA256 = /^[a-f0-9]{64}$/;
const allowedErrors = new Set([
  'FILE_NOT_FOUND', 'REPARSE_POINT', 'HASH_MISMATCH', 'BAD_SIGNATURE',
  'PUBLISHER_MISMATCH', 'CERTIFICATE_MISMATCH', 'CHANGED_DURING_VERIFICATION',
]);

export interface WindowsBinaryTrustPins {
  filePath: string;
  expectedSha256: string;
  expectedPublisherSubject: string;
  expectedCertificateSha256: string;
}
export interface WindowsBinaryTrustEvidence {
  status: 'signature_verified';
  fileSha256: string;
  certificateSha256: string;
  publisherSubject: string;
  /** This result is preflight only, never a promise that a later process uses these same bytes. */
  safeToExecute: false;
  productionModified: false;
}

function error(code: string): never { throw new Error('S3_BINARY_' + code); }
function psLiteral(s: string): string { return "'" + s.replaceAll("'", "''") + "'"; }
function checkedPins(pins: WindowsBinaryTrustPins): WindowsBinaryTrustPins {
  if (!pins || typeof pins !== 'object' ||
      typeof pins.filePath !== 'string' ||
      pins.filePath.length > 4096 || pins.filePath.length < 6 ||
      !path.win32.isAbsolute(pins.filePath) ||
      !/^[A-Za-z]:\\/.test(pins.filePath) ||
      pins.filePath.slice(2).includes(':') || /[\u0000-\u001f]/.test(pins.filePath)) error('PATH_INVALID');
  if (!SHA256.test(pins.expectedSha256) ||
      !SHA256.test(pins.expectedCertificateSha256)) error('PIN_INVALID');
  if (typeof pins.expectedPublisherSubject !== 'string' ||
      pins.expectedPublisherSubject.length < 6 ||
      pins.expectedPublisherSubject.length > 512 ||
      /[\u0000-\u001f]/.test(pins.expectedPublisherSubject)) error('PUBLISHER_INVALID');
  return { ...pins, filePath: path.win32.normalize(pins.filePath) };
}

/** Pure pins validation; does not inspect the Windows machine or run code. */
export function validateWindowsBinaryTrustPins(input: WindowsBinaryTrustPins): WindowsBinaryTrustPins {
  return checkedPins(input);
}

/**
 * One bounded Windows PowerShell process with a fixed OS binary and sanitized
 * environment. Hash before and after native Get-AuthenticodeSignature; pin
 * the signer certificate DER SHA-256 and exact publisher Subject.
 *
 * This verifies a FILE at a moment in time. Do not launch it without an
 * installer-owned, protected file handle and independent cutover policy.
 */
export function inspectSignedWindowsBinary(
  input: WindowsBinaryTrustPins,
  platform: NodeJS.Platform = process.platform,
): WindowsBinaryTrustEvidence {
  const pins = checkedPins(input);
  if (platform !== 'win32') error('WINDOWS_REQUIRED');
  const script = [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    'function Deny([string]$code){throw ("S3_BINARY_"+$code)}',
    '$file=' + psLiteral(pins.filePath),
    '$sha=' + psLiteral(pins.expectedSha256),
    '$certPin=' + psLiteral(pins.expectedCertificateSha256),
    '$subjectPin=' + psLiteral(pins.expectedPublisherSubject),
    // Windows drive root and every intermediate directory must not be a junction.
    '$cursor=$file',
    'while($cursor){',
    '  $item=Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue',
    "  if($null -eq $item){Deny 'FILE_NOT_FOUND'}",
    "  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){Deny 'REPARSE_POINT'}",
    '  $parent=Split-Path -Path $cursor -Parent',
    '  if(-not $parent -or $parent -eq $cursor){break}',
    '  $cursor=$parent',
    '}',
    "if((Get-Item -LiteralPath $file).PSIsContainer){Deny 'FILE_NOT_FOUND'}",
    "$before=(Get-FileHash -LiteralPath $file -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()",
    "if($before -cne $sha){Deny 'HASH_MISMATCH'}",
    '$sig=Get-AuthenticodeSignature -LiteralPath $file -ErrorAction Stop',
    "if($sig.Status -ne [Management.Automation.SignatureStatus]::Valid -or $null -eq $sig.SignerCertificate){Deny 'BAD_SIGNATURE'}",
    "if($sig.SignerCertificate.Subject -cne $subjectPin){Deny 'PUBLISHER_MISMATCH'}",
    '$hash=[Security.Cryptography.SHA256]::Create()',
    'try{$cert=([BitConverter]::ToString($hash.ComputeHash($sig.SignerCertificate.RawData))).Replace("-","").ToLowerInvariant()}finally{$hash.Dispose()}',
    "if($cert -cne $certPin){Deny 'CERTIFICATE_MISMATCH'}",
    "$after=(Get-FileHash -LiteralPath $file -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()",
    "if($after -cne $before){Deny 'CHANGED_DURING_VERIFICATION'}",
    "Write-Output 'S3_BINARY_SIGNATURE_VERIFIED'",
  ].join('\r\n');
  const result = spawnSync(WINDOWS_POWERSHELL, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], {
    cwd: WINDOWS_SYSTEM32,
    env: {
      SystemRoot: 'C:\\Windows',
      windir: 'C:\\Windows',
      PATH: 'C:\\Windows\\System32;C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
    },
    encoding: 'utf8', windowsHide: true, shell: false,
    timeout: 20_000, maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0 ||
      result.stdout?.trim() !== 'S3_BINARY_SIGNATURE_VERIFIED') {
    const detail = String(result.stderr ?? '');
    // Windows PowerShell 5.1 may encode CR/LF as _x000D__x000A_ in CLIXML.
    // Match only known complete error identifiers, never arbitrary stderr.
    const code = [...allowedErrors].find((candidate) =>
      new RegExp('S3_BINARY_' + candidate + '(?![A-Z])').test(detail));
    error(code ?? 'UNVERIFIED');
  }
  return {
    status: 'signature_verified',
    fileSha256: pins.expectedSha256,
    certificateSha256: pins.expectedCertificateSha256,
    publisherSubject: pins.expectedPublisherSubject,
    safeToExecute: false,
    productionModified: false,
  };
}
