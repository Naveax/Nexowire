import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const REPOSITORY = 'Naveax/Nexowire';
const UPDATE_SYSTEM32='C:\\Windows\\System32';
const UPDATE_POWERSHELL=UPDATE_SYSTEM32+'\\WindowsPowerShell\\v1.0\\powershell.exe';
const UPDATE_ICACLS=UPDATE_SYSTEM32+'\\icacls.exe';
/** Machine update may mutate ACLs and start a detached cutover. Do not let
 * the invoking process select binaries or PowerShell modules via PATH. */
export function isolatedMachineUpdateChildEnvironment():NodeJS.ProcessEnv {
  return {
    SystemRoot:'C:\\Windows',
    windir:'C:\\Windows',
    ComSpec:UPDATE_SYSTEM32+'\\cmd.exe',
    PATH:UPDATE_SYSTEM32+';C:\\Windows',
    PSModulePath:UPDATE_SYSTEM32+'\\WindowsPowerShell\\v1.0\\Modules',
  };
}


interface MachineUpdateInput {
  version: string;
  buildId: string;
}

function validateInput(input: unknown): MachineUpdateInput {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input)
  ) {
    throw new Error('Machine update input must be an object.');
  }
  const record = input as Record<string, unknown>;
  const version =
    typeof record.version === 'string'
      ? record.version.trim().replace(/^v/, '')
      : '';
  const buildId =
    typeof record.buildId === 'string'
      ? record.buildId.trim()
      : '';
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('Machine update version is invalid.');
  }
  if (
    !new RegExp(
      '^' +
        version.replaceAll('.', '\\.') +
        '-[a-f0-9]{12}$',
      'i',
    ).test(buildId)
  ) {
    throw new Error('Machine update build ID is invalid.');
  }
  return { version, buildId };
}

const TRUSTED_MACHINE_PROGRAMDATA='C:\\ProgramData';
/** Never let an elevated updater stage/recurse ACLs in caller-selected roots.
 * ProgramData is an environment variable, not a trusted path capability. */
export function trustedMachineUpdateRoot(programData:string):string {
  if(!programData ||
     programData.startsWith('\\\\') ||
     programData.includes('\0') ||
     programData.split(/[\\\\/]/).includes('..') ||
     !/^[A-Za-z]:\\/.test(programData) ||
     !path.win32.isAbsolute(programData) ||
     path.win32.resolve(programData).toLowerCase()!==TRUSTED_MACHINE_PROGRAMDATA.toLowerCase()){
    throw new Error('MACHINE_UPDATE_UNTRUSTED_PROGRAMDATA_ROOT');
  }
  return path.win32.join(TRUSTED_MACHINE_PROGRAMDATA,'Nexowire');
}

function programDataRoot(): string {
  return trustedMachineUpdateRoot(
    process.env.ProgramData ?? TRUSTED_MACHINE_PROGRAMDATA,
  );
}

function psLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function hardenAcl(root: string): void {
  const result = spawnSync(
    UPDATE_ICACLS,
    [
      root,
      '/inheritance:r',
      '/grant:r',
      '*S-1-5-18:(OI)(CI)F',
      '*S-1-5-32-544:(OI)(CI)F',
      '/remove:g',
      '*S-1-5-32-545',
      '/T',
      '/C',
      '/Q',
    ],
    {
      windowsHide: true,
      shell:false,
      cwd:UPDATE_SYSTEM32,
      env:isolatedMachineUpdateChildEnvironment(),
      timeout:180_000,
      maxBuffer:2*1024*1024,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        'Failed to harden Nexowire machine update ACL.',
    );
  }
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: {
      accept: 'application/octet-stream',
      'user-agent': 'Nexowire-machine-updater',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) {
    throw new Error(
      'Official machine update download failed: HTTP ' +
        response.status,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function checksums(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match =
      /^([a-fA-F0-9]{64})\s{2}(.+)$/.exec(line.trim());
    if (!match) {
      throw new Error(
        'Official Windows checksum file is invalid.',
      );
    }
    result.set(match[2]!, match[1]!.toLowerCase());
  }
  return result;
}

function setupMetadata(text: string): {
  version: string;
  buildId: string;
} {
  const version =
    /set "NX_VERSION=([^"]+)"/i.exec(text)?.[1] ?? '';
  const buildId =
    /set "NX_BUILD_ID=([^"]+)"/i.exec(text)?.[1] ?? '';
  return { version, buildId };
}

async function extractVerifiedRuntime(
  input: MachineUpdateInput,
): Promise<string> {
  const base =
    'https://github.com/' +
    REPOSITORY +
    '/releases/download/v' +
    input.version;
  const [sumsBuffer, setupBuffer, zipBuffer] =
    await Promise.all([
      fetchBuffer(base + '/SHA256SUMS-Windows'),
      fetchBuffer(base + '/Nexowire-Setup.cmd'),
      fetchBuffer(base + '/Nexowire-Windows-x64.zip'),
    ]);

  const expected = checksums(sumsBuffer.toString('utf8'));
  const setupExpected = expected.get('Nexowire-Setup.cmd');
  const zipExpected =
    expected.get('Nexowire-Windows-x64.zip');
  if (!setupExpected || !zipExpected) {
    throw new Error(
      'Official Windows release checksums are incomplete.',
    );
  }
  if (sha256(setupBuffer) !== setupExpected) {
    throw new Error('Official setup checksum mismatch.');
  }
  if (sha256(zipBuffer) !== zipExpected) {
    throw new Error('Official Windows payload checksum mismatch.');
  }

  const metadata = setupMetadata(
    setupBuffer.toString('utf8'),
  );
  if (
    metadata.version !== input.version ||
    metadata.buildId !== input.buildId
  ) {
    throw new Error(
      'Requested machine update does not match official release metadata.',
    );
  }

  const root = programDataRoot();
  const versions = path.join(root, 'versions');
  const target = path.join(versions, input.buildId);
  const targetNode = path.join(
    target,
    'runtime',
    'node.exe',
  );
  const targetCli = path.join(
    target,
    'app',
    'dist',
    'src',
    'cli.js',
  );
  try {
    await fs.access(targetNode);
    await fs.access(targetCli);
    hardenAcl(target);
    return target;
  } catch {
    // Continue with a clean official extraction.
  }

  await fs.mkdir(versions, { recursive: true });
  const staging = path.join(
    root,
    'update',
    'stage-' + input.buildId + '-' + randomUUID(),
  );
  const zipFile = path.join(
    staging,
    'Nexowire-Windows-x64.zip',
  );
  const extract = path.join(staging, 'extract');
  await fs.mkdir(extract, { recursive: true });
  await fs.writeFile(zipFile, zipBuffer);

  const script =
    "$ErrorActionPreference='Stop'; " +
    'Add-Type -AssemblyName System.IO.Compression.FileSystem; ' +
    '[System.IO.Compression.ZipFile]::ExtractToDirectory(' +
    psLiteral(zipFile) +
    ', ' +
    psLiteral(extract) +
    ');';
  const result = spawnSync(
    UPDATE_POWERSHELL,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ],
    {
      windowsHide: true,
      shell:false,
      cwd:UPDATE_SYSTEM32,
      env:isolatedMachineUpdateChildEnvironment(),
      timeout:180_000,
      maxBuffer:2*1024*1024,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        'Official machine update extraction failed.',
    );
  }

  const source = path.join(extract, 'Nexowire');
  await fs.access(path.join(source, 'runtime', 'node.exe'));
  await fs.access(
    path.join(source, 'app', 'dist', 'src', 'cli.js'),
  );
  try {
    await fs.rename(source, target);
  } catch (error) {
    try {
      await fs.access(targetNode);
      await fs.access(targetCli);
    } catch {
      throw error;
    }
  }
  hardenAcl(target);
  await fs.rm(staging, { recursive: true, force: true });
  return target;
}

export function renderMachineCutoverScript(input: {
  targetRoot: string;
  version: string;
  buildId: string;
}): string {
  const root = programDataRoot();
  const status = path.join(
    root,
    'update',
    'machine-status.json',
  );
  const brokerLauncher = path.join(
    root,
    'privileged-broker',
    'launch.ps1',
  );
  const bootLauncher = path.join(
    root,
    'hub-boot',
    'launch.ps1',
  );
  return [
    "$ErrorActionPreference='Stop'",
    '$NewRoot=' + psLiteral(input.targetRoot),
    '$Version=' + psLiteral(input.version),
    '$BuildId=' + psLiteral(input.buildId),
    '$Status=' + psLiteral(status),
    '$BrokerLauncher=' + psLiteral(brokerLauncher),
    '$BootLauncher=' + psLiteral(bootLauncher),
    "$BrokerTask='Nexowire Privileged Broker'",
    "$BootTask='Nexowire Hub Boot'",
    '$backups=@{}',
    'function Task-Exists([string]$name){return $null-ne(Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue)}',
    'function Patch-Launcher([string]$file){',
    '  if(-not(Test-Path -LiteralPath $file)){return}',
    '  $text=Get-Content -LiteralPath $file -Raw',
    '  if($text.Contains($NewRoot)){return}',
    "  $pattern='[A-Za-z]:\\\\[^''\"\\r\\n]*Nexowire\\\\versions\\\\[0-9]+\\.[0-9]+\\.[0-9]+-[a-f0-9]{12}'",
    '  $match=[regex]::Match($text,$pattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase)',
    '  if(-not $match.Success){throw (\'Versioned runtime not found in machine launcher: \'+$file)}',
    '  $backup=$file+\'.update-rollback\'',
    '  Copy-Item -LiteralPath $file -Destination $backup -Force',
    '  $backups[$file]=$backup',
    '  Set-Content -LiteralPath $file -Value ($text.Replace($match.Value,$NewRoot)) -Encoding UTF8',
    '}',
    'function Restore {foreach($entry in $backups.GetEnumerator()){Copy-Item -LiteralPath $entry.Value -Destination $entry.Key -Force}}',
    'function Wait-Port([int]$port,[int]$seconds){$until=(Get-Date).AddSeconds($seconds);while((Get-Date)-lt$until){if(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue){return $true};Start-Sleep -Milliseconds 500};return $false}',
    'function Wait-Mode([string]$needle,[int]$seconds){$until=(Get-Date).AddSeconds($seconds);while((Get-Date)-lt$until){$p=Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" -ErrorAction SilentlyContinue|Where-Object{$_.CommandLine -match [regex]::Escape($NewRoot) -and $_.CommandLine -match $needle};if($p){return $true};Start-Sleep -Milliseconds 500};return $false}',
    'function Write-Status([string]$state,[string]$message=$null){[ordered]@{state=$state;version=$Version;buildId=$BuildId;targetRoot=$NewRoot;updatedAt=(Get-Date).ToUniversalTime().ToString(\'o\');error=$message}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $Status -Encoding UTF8}',
    'Start-Sleep -Seconds 3',
    '$hasBoot=Task-Exists $BootTask',
    '$hasBroker=Task-Exists $BrokerTask',
    'try {',
    '  Patch-Launcher $BootLauncher',
    '  Patch-Launcher $BrokerLauncher',
    '  if($hasBoot){Stop-ScheduledTask -TaskName $BootTask -ErrorAction SilentlyContinue}',
    '  if($hasBroker){Stop-ScheduledTask -TaskName $BrokerTask -ErrorAction SilentlyContinue}',
    '  Start-Sleep -Seconds 1',
    '  if($hasBoot){Start-ScheduledTask -TaskName $BootTask; if(-not(Wait-Port 43110 30)){throw \'Updated SYSTEM Hub did not listen on 43110\'}; if(-not(Wait-Mode \'cli\\.js http\' 10)){throw \'Updated SYSTEM Hub is not using the new runtime\'}}',
    '  if($hasBroker){Start-ScheduledTask -TaskName $BrokerTask; if(-not(Wait-Port 43112 20)){throw \'Updated Admin Bridge did not listen on 43112\'}; if(-not(Wait-Mode \'privileged-broker run\' 10)){throw \'Updated Admin Bridge is not using the new runtime\'}}',
    "  Write-Status 'succeeded'",
    '} catch {',
    '  $message=$_.Exception.Message',
    '  if($hasBoot){Stop-ScheduledTask -TaskName $BootTask -ErrorAction SilentlyContinue}',
    '  if($hasBroker){Stop-ScheduledTask -TaskName $BrokerTask -ErrorAction SilentlyContinue}',
    '  Restore',
    '  if($hasBoot){Start-ScheduledTask -TaskName $BootTask -ErrorAction SilentlyContinue}',
    '  Start-Sleep -Seconds 2',
    '  if($hasBroker){Start-ScheduledTask -TaskName $BrokerTask -ErrorAction SilentlyContinue}',
    "  Write-Status 'rolled_back' $message",
    '  exit 1',
    '}',
    '',
  ].join('\r\n');
}

export async function scheduleOfficialMachineUpdate(
  rawInput: unknown,
): Promise<{
  scheduled: boolean;
  version: string;
  buildId: string;
  targetRoot: string;
}> {
  if (process.platform !== 'win32') {
    throw new Error('Machine update requires Windows.');
  }
  const input = validateInput(rawInput);
  const targetRoot = await extractVerifiedRuntime(input);
  const updateDir = path.join(
    programDataRoot(),
    'update',
  );
  await fs.mkdir(updateDir, { recursive: true });
  hardenAcl(programDataRoot());
  const helper = path.join(
    updateDir,
    'apply-machine-' + input.buildId + '.ps1',
  );
  await fs.writeFile(
    helper,
    renderMachineCutoverScript({
      targetRoot,
      version: input.version,
      buildId: input.buildId,
    }),
    'utf8',
  );
  hardenAcl(programDataRoot());

  const child = spawn(
    UPDATE_POWERSHELL,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      helper,
    ],
    {
      detached: true,
      windowsHide: true,
      shell:false,
      cwd:UPDATE_SYSTEM32,
      env:isolatedMachineUpdateChildEnvironment(),
      stdio: 'ignore',
    },
  );
  child.unref();
  return {
    scheduled: true,
    version: input.version,
    buildId: input.buildId,
    targetRoot,
  };
}
