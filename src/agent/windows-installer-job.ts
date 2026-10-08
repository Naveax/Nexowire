import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod';
import {
  hardenWindowsProgramDataAcl,
  windowsProgramDataAclArguments,
} from '../security/windows-programdata-acl.js';

export const VerifiedInstallerInputSchema = z.object({
  file_path: z.string().trim().min(1).max(4096),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  arguments: z.array(z.string().max(512).regex(/^[^"\r\n]*$/)).max(16).default([]),
  allow_unsigned: z.boolean().default(false),
  publisher_thumbprint: z.string().regex(/^[a-fA-F0-9]{40}$/).optional(),
  timeout_seconds: z.number().int().min(10).max(1800).default(600),
}).strict();

export type VerifiedInstallerInput = z.infer<
  typeof VerifiedInstallerInputSchema
>;

const supportedExtensions = new Set(['.exe', '.msi', '.ps1', '.cmd']);

const ApprovalSchema = z.object({
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  arguments: z.array(z.string().max(512).regex(/^[^"\r\n]*$/)).max(16),
  allow_unsigned: z.boolean(),
  publisher_thumbprint: z.string().regex(/^[a-fA-F0-9]{40}$/).nullable(),
}).strict();
const ApprovalFileSchema = z.object({
  version: z.literal(1),
  approvals: z.array(ApprovalSchema).max(128),
}).strict();

/**
 * Approval records are provisioned by the device administrator in
 * protected ProgramData, NEVER by an unprivileged request or this API.
 * Hash, exact argument vector and signer policy must all match.
 */
export function installerApprovalMatches(
  input: VerifiedInstallerInput,
  file: unknown,
): boolean {
  const parsed = ApprovalFileSchema.parse(file);
  return parsed.approvals.some((approval) =>
    approval.sha256.toLowerCase() === input.sha256.toLowerCase() &&
    approval.allow_unsigned === input.allow_unsigned &&
    (approval.publisher_thumbprint?.toLowerCase() ?? null) ===
      (input.publisher_thumbprint?.toLowerCase() ?? null) &&
    approval.arguments.length === input.arguments.length &&
    approval.arguments.every((arg, i) => arg === input.arguments[i])
  );
}

function approvalFile(): string {
  return path.join(
    process.env.ProgramData ?? 'C:\\ProgramData',
    'Nexowire',
    'installer-approvals.json',
  );
}

async function assertPreapprovedInstaller(
  input: VerifiedInstallerInput,
): Promise<void> {
  const file = approvalFile();
  const script = [
    "$ErrorActionPreference='Stop'",
    '$file=' + psLiteral(file),
    '$acl=Get-Acl -LiteralPath $file -ErrorAction Stop',
    'if(-not $acl.AreAccessRulesProtected){throw "Approval file ACL inheritance must be disabled"}',
    "$allowed=@('S-1-5-18','S-1-5-32-544')",
    'try{$ownerSid=([System.Security.Principal.NTAccount]$acl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{$ownerSid=$acl.Owner}',
    'if($ownerSid -notin $allowed){throw "Approval file must be owned by SYSTEM or Administrators"}',
    'foreach($ace in $acl.Access){',
    '  $sid=$ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value',
    '  if($sid -notin $allowed){throw "Approval file ACL permits unexpected identity"}',
    '}',
  ].join('\n');
  const acl = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive',
    '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (acl.status !== 0) {
    throw new Error(
      'Installer approval policy is missing or not protected by machine ACL.',
    );
  }
  const body: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!installerApprovalMatches(input, body)) {
    throw new Error(
      'Installer payload, exact arguments, and signer policy are not preapproved by this device administrator.',
    );
  }
}


export function validateInstallerInput(input: unknown): VerifiedInstallerInput {
  const parsed = VerifiedInstallerInputSchema.parse(input);
  if (
    process.platform === 'win32' &&
    (!path.win32.isAbsolute(parsed.file_path) ||
      parsed.file_path.startsWith('\\\\'))
  ) {
    throw new Error('Installer must be an absolute local Windows file path.');
  }
  if (
    !supportedExtensions.has(path.win32.extname(parsed.file_path).toLowerCase())
  ) {
    throw new Error('Installer must be an .exe, .msi, .ps1, or .cmd file.');
  }
  if (parsed.publisher_thumbprint && parsed.allow_unsigned) {
    throw new Error(
      'Do not specify both a required publisher and allow_unsigned.',
    );
  }
  return parsed;
}

export function installerProgramDataRoot(
  programData: string = process.env.ProgramData ?? 'C:\\ProgramData',
): string {
  return path.join(programData, 'Nexowire', 'verified-installers');
}

/**
 * A same-user, non-elevated process could otherwise rewrite an NTFS ACL
 * using implicit owner WRITE_DAC even when all explicit user ACEs were
 * stripped. Machine-owned job objects must have an Administrators owner.
 */
function setProtectedOwner(target: string, recursive = false): void {
  const result = spawnSync(
    'icacls.exe',
    [
      target,
      '/setowner',
      '*S-1-5-32-544',
      ...(recursive ? ['/T', '/C'] : []),
      '/Q',
    ],
    {
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() ||
      'Failed to assign protected installer object owner.',
    );
  }
}

function hardenContainerAcl(directory: string): void {
  const result = spawnSync(
    'icacls.exe',
    windowsProgramDataAclArguments(directory, true),
    {
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() ||
      'Failed to protect verified installer directory.',
    );
  }
  setProtectedOwner(directory);
}

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

function psLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

/**
 * The helper runs as a child of the already elevated, pre-authorized broker.
 * It never invokes -Verb RunAs or clicks Windows Secure Desktop. The payload
 * is a hash-pinned copy under SYSTEM/Administrators-only ProgramData.
 */
export function renderVerifiedInstallerRunner(
  jobDirectory: string,
): string {
  const manifest = path.join(jobDirectory, 'manifest.json');
  const status = path.join(jobDirectory, 'status.json');
  return [
    "$ErrorActionPreference='Stop'",
    '$JobDir=' + psLiteral(jobDirectory),
    '$Manifest=' + psLiteral(manifest),
    '$Status=' + psLiteral(status),
    'function Write-State([string]$state,[string]$message=$null,[int]$exitCode=-1,[bool]$reboot=$false){',
    '  $data=[ordered]@{state=$state;updatedAt=(Get-Date).ToUniversalTime().ToString("o");error=$message;exitCode=$exitCode;rebootRequired=$reboot}',
    '  $temp=$Status+".tmp"',
    '  $data|ConvertTo-Json -Compress|Set-Content -LiteralPath $temp -Encoding UTF8',
    '  Move-Item -LiteralPath $temp -Destination $Status -Force',
    '}',
    'try {',
    '  $m=Get-Content -LiteralPath $Manifest -Raw|ConvertFrom-Json',
    '  $pkg=Join-Path $JobDir ("package"+[string]$m.extension)',
    '  if(-not(Test-Path -LiteralPath $pkg -PathType Leaf)){throw "Missing protected installer payload"}',
    '  if((Get-FileHash -LiteralPath $pkg -Algorithm SHA256).Hash.ToLowerInvariant() -ne $m.sha256){throw "Protected installer SHA-256 mismatch"}',
    '  $signature=Get-AuthenticodeSignature -LiteralPath $pkg',
    '  if(-not $m.allow_unsigned -and [string]$signature.Status -ne "Valid"){throw "Installer Authenticode signature is not valid"}',
    '  if($m.publisher_thumbprint -and (([string]$signature.SignerCertificate.Thumbprint).ToLowerInvariant() -ne $m.publisher_thumbprint)){throw "Unexpected installer signer certificate"}',
    '  Write-State "running"',
    '  $arguments=@($m.arguments)',
    '  if($m.extension -eq ".msi"){',
    '    $program=Join-Path $env:WINDIR "System32\\msiexec.exe"',
    '    $arguments=@("/i",$pkg,"/qn","/norestart")',
    '  } elseif($m.extension -eq ".ps1"){',
    '    $program=Join-Path $env:WINDIR "System32\\WindowsPowerShell\\v1.0\\powershell.exe"',
    '    $arguments=@("-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",$pkg)+@($m.arguments)',
    '  } elseif($m.extension -eq ".cmd"){',
    '    $program=Join-Path $env:WINDIR "System32\\cmd.exe"',
    '    $arguments=@("/d","/c",$pkg)+@($m.arguments)',
    '  } else {',
    '    $program=$pkg',
    '  }',
    '  $argumentsText=(@($arguments)|ForEach-Object{([char]34+([string]$_)+[char]34)}) -join " "',
    '  if($argumentsText){',
    '    $process=Start-Process -FilePath $program -ArgumentList $argumentsText -PassThru -WorkingDirectory $JobDir -WindowStyle Hidden',
    '  }else{',
    '    $process=Start-Process -FilePath $program -PassThru -WorkingDirectory $JobDir -WindowStyle Hidden',
    '  }',
    '  if(-not $process.WaitForExit([int]$m.timeoutMs)){',
    '    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue',
    '    throw "Verified installer exceeded the bounded timeout"',
    '  }',
    '  $code=$process.ExitCode',
    '  if($code -ne 0 -and $code -ne 3010){throw ("Verified installer failed with exit code "+$code)}',
    '  Write-State "succeeded" $null $code ($code -eq 3010)',
    '} catch {',
    '  Write-State "failed" $_.Exception.Message',
    '  exit 1',
    '}',
    '',
  ].join('\r\n');
}

async function launchProtectedInstaller(script: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive',
        '-ExecutionPolicy', 'Bypass', '-File', script],
      {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      },
    );
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', reject);
  });
}

export async function scheduleVerifiedInstaller(
  raw: unknown,
): Promise<{
  scheduled: boolean;
  jobId: string;
  state: 'queued';
  expectedSha256: string;
}> {
  if (process.platform !== 'win32') {
    throw new Error('Trusted elevated installer jobs require Windows.');
  }
  const input = validateInstallerInput(raw);
  const source = await fs.realpath(input.file_path);
  const userHome = (await fs.realpath(os.homedir())).toLowerCase();
  if (
    !source.toLowerCase().startsWith(userHome + path.sep) ||
    !path.win32.isAbsolute(source)
  ) {
    throw new Error(
      'Installer source must be a local file inside the current user profile.',
    );
  }
  const stat = await fs.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_147_483_648) {
    throw new Error('Installer must be a regular file of at most 2 GiB.');
  }
  const expectedSha = input.sha256.toLowerCase();
  if (await digest(source) !== expectedSha) {
    throw new Error('Submitted installer SHA-256 does not match the file.');
  }

  // Crucial boundary: a caller-provided SHA alone never authorizes
  // arbitrary elevated code. Approval must preexist outside user control.
  await assertPreapprovedInstaller(input);

  const root = installerProgramDataRoot();
  await fs.mkdir(root, { recursive: true });
  hardenContainerAcl(root);

  const jobId = randomUUID();
  const jobDirectory = path.join(root, jobId);
  await fs.mkdir(jobDirectory);
  hardenWindowsProgramDataAcl(jobDirectory);
  const extension = path.win32.extname(source).toLowerCase();
  const stagedFile = path.join(jobDirectory, 'package' + extension);
  await fs.copyFile(source, stagedFile);
  if (await digest(stagedFile) !== expectedSha) {
    throw new Error('Protected installer staging hash mismatch.');
  }
  const manifest = {
    version: 1,
    sha256: expectedSha,
    extension,
    arguments: input.arguments,
    allow_unsigned: input.allow_unsigned,
    publisher_thumbprint: input.publisher_thumbprint?.toLowerCase() ?? null,
    timeoutMs: input.timeout_seconds * 1000,
  };
  await fs.writeFile(
    path.join(jobDirectory, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );
  const runner = path.join(jobDirectory, 'run.ps1');
  await fs.writeFile(
    runner,
    renderVerifiedInstallerRunner(jobDirectory),
    'utf8',
  );
  await fs.writeFile(
    path.join(jobDirectory, 'status.json'),
    JSON.stringify({
      state: 'queued',
      updatedAt: new Date().toISOString(),
      error: null,
      exitCode: null,
      rebootRequired: false,
    }) + '\n',
    'utf8',
  );
  hardenWindowsProgramDataAcl(jobDirectory);
  setProtectedOwner(jobDirectory, true);
  await launchProtectedInstaller(runner);
  return {
    scheduled: true,
    jobId,
    state: 'queued',
    expectedSha256: expectedSha,
  };
}

export async function readVerifiedInstallerStatus(
  raw: unknown,
): Promise<unknown> {
  const parsed = z.object({
    job_id: z.string().uuid(),
  }).strict().parse(raw);
  const file = path.join(
    installerProgramDataRoot(),
    parsed.job_id,
    'status.json',
  );
  return {
    jobId: parsed.job_id,
    status: JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')) as unknown,
  };
}
