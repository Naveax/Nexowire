import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assertMachineUpdateTreeProtectedBeforeWrite } from '../security/windows-machine-update-tree-trust.js';
import { assertWindowsPrivilegedRuntimeTrusted } from '../security/windows-privileged-runtime-trust.js';

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

const MAX_RELEASE_CHECKSUM_BYTES=128*1024;
const MAX_RELEASE_SETUP_BYTES=2*1024*1024;
const MAX_RELEASE_ZIP_BYTES=256*1024*1024;

/** Consume HTTP bodies with a hard size limit even if Content-Length is
 * absent, falsified, or describes only compressed transfer bytes. */
export async function readBoundedReleaseResponse(
  response:Response,
  maxBytes:number,
):Promise<Buffer>{
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1){
    throw new Error('MACHINE_UPDATE_ASSET_LIMIT_INVALID');
  }
  const declared=response.headers.get('content-length');
  if(declared!==null && /^\d+$/.test(declared) && BigInt(declared)>BigInt(maxBytes)){
    throw new Error('MACHINE_UPDATE_ASSET_TOO_LARGE');
  }
  if(!response.body){
    throw new Error('MACHINE_UPDATE_ASSET_BODY_MISSING');
  }
  const chunks:Buffer[]=[];
  let total=0;
  const reader=response.body.getReader();
  try{
    while(true){
      const item=await reader.read();
      if(item.done)break;
      if(!(item.value instanceof Uint8Array)){
        throw new Error('MACHINE_UPDATE_ASSET_INVALID_CHUNK');
      }
      total+=item.value.byteLength;
      if(total>maxBytes){
        await reader.cancel().catch(()=>{});
        throw new Error('MACHINE_UPDATE_ASSET_TOO_LARGE');
      }
      chunks.push(Buffer.from(item.value));
    }
  }finally{
    reader.releaseLock();
  }
  return Buffer.concat(chunks,total);
}

async function fetchBuffer(url: string,maxBytes:number): Promise<Buffer> {
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
  return readBoundedReleaseResponse(response,maxBytes);
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

export function renderBoundedWindowsArchiveExtraction(
  zipFile:string,extract:string,
):string{
  return [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.IO.Compression',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '$archivePath='+psLiteral(zipFile),
    '$extractPath='+psLiteral(extract),
    'if(-not [IO.File]::Exists($archivePath)){throw "MACHINE_UPDATE_ARCHIVE_MISSING"}',
    'if(-not [IO.Directory]::Exists($extractPath)){throw "MACHINE_UPDATE_EXTRACT_ROOT_MISSING"}',
    '$destination=[IO.Path]::GetFullPath($extractPath).TrimEnd([char]92)+[char]92',
    '$archive=[IO.Compression.ZipFile]::OpenRead($archivePath)',
    '$maxEntries=25000',
    '$maxEntryBytes=[long](128MB)',
    '$maxTotalBytes=[long](1024MB)',
    '$count=0',
    '$total=[long]0',
    '$targets=New-Object \'System.Collections.Generic.HashSet[string]\' ([StringComparer]::OrdinalIgnoreCase)',
    'try {',
    '  foreach($entry in $archive.Entries){',
    '    $count++',
    '    if($count -gt $maxEntries){throw "MACHINE_UPDATE_ARCHIVE_TOO_MANY_ENTRIES"}',
    "    $n=$entry.FullName.Replace('/',[char]92)",
    '    if([string]::IsNullOrWhiteSpace($n) -or $n.StartsWith([string][char]92) -or $n.Contains(":") -or @($n.Split([char]92)|Where-Object{$_ -eq ".."}).Count -gt 0){throw "MACHINE_UPDATE_ARCHIVE_UNSAFE_ENTRY"}',
    '    foreach($part in $n.Split([char]92)){if(!$part){continue};if($part.EndsWith(".") -or $part.EndsWith(" ") -or $part -match "^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\\..*)?$" ){throw "MACHINE_UPDATE_ARCHIVE_WINDOWS_PATH_ALIAS"}}',
    '    $full=[IO.Path]::GetFullPath([IO.Path]::Combine($destination,$n))',
    '    if(-not $full.StartsWith($destination,[StringComparison]::OrdinalIgnoreCase)){throw "MACHINE_UPDATE_ARCHIVE_ESCAPE"}',
    '    if(-not $targets.Add($full.TrimEnd([char]92))){throw "MACHINE_UPDATE_ARCHIVE_DUPLICATE_TARGET"}',
    '    if($entry.Length -lt 0 -or $entry.Length -gt $maxEntryBytes){throw "MACHINE_UPDATE_ARCHIVE_ENTRY_TOO_LARGE"}',
    '    if($n.EndsWith([string][char]92) -and $entry.Length -ne 0){throw "MACHINE_UPDATE_ARCHIVE_DIRECTORY_HAS_DATA"}',
    '    $total+=[long]$entry.Length',
    '    if($total -gt $maxTotalBytes){throw "MACHINE_UPDATE_ARCHIVE_TOTAL_TOO_LARGE"}',
    '    if((([int]$entry.ExternalAttributes -shr 16) -band 61440) -eq 40960){throw "MACHINE_UPDATE_ARCHIVE_SYMLINK"}',
    '  }',
    '  # Keep this same trusted ZIP handle open through extraction, preventing',
    '  # a second open of a substituted archive after the metadata preflight.',
    '  $actualTotal=[long]0',
    '  $buffer=New-Object byte[] 65536',
    '  foreach($entry in $archive.Entries){',
    "    $n=$entry.FullName.Replace('/',[char]92)",
    '    $full=[IO.Path]::GetFullPath([IO.Path]::Combine($destination,$n))',
    "    if($n.EndsWith([string][char]92)){[void][IO.Directory]::CreateDirectory($full);continue}",
    '    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($full))',
    '    $stream=$entry.Open()',
    '    $output=$null',
    '    $actualEntry=[long]0',
    '    try {',
    '      $output=[IO.File]::Open($full,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)',
    '      while(($read=$stream.Read($buffer,0,$buffer.Length)) -gt 0){',
    '        $actualEntry+=[long]$read',
    '        $actualTotal+=[long]$read',
    '        if($actualEntry -gt $maxEntryBytes){throw "MACHINE_UPDATE_ARCHIVE_ACTUAL_ENTRY_TOO_LARGE"}',
    '        if($actualTotal -gt $maxTotalBytes){throw "MACHINE_UPDATE_ARCHIVE_ACTUAL_TOTAL_TOO_LARGE"}',
    '        $output.Write($buffer,0,$read)',
    '      }',
    '      if($actualEntry -ne [long]$entry.Length){throw "MACHINE_UPDATE_ARCHIVE_LENGTH_MISMATCH"}',
    '    } finally {',
    '      if($output){$output.Dispose()}',
    '      $stream.Dispose()',
    '    }',
    '  }',
    '} finally { $archive.Dispose() }',
  ].join('\r\n');
}

/** Only this updater's randomly named child of the protected update root
 * may ever be passed to recursive staging cleanup. */
export function assertMachineUpdateOwnedStage(root:string,staging:string):void{
  const trusted=path.win32.join(TRUSTED_MACHINE_PROGRAMDATA,'Nexowire');
  const parent=path.win32.join(trusted,'update');
  const base=typeof staging==='string'?path.win32.basename(staging):'';
  if(root!==trusted ||
     typeof staging!=='string' ||
     path.win32.dirname(staging)!==parent ||
     staging!==path.win32.join(parent,base) ||
     !/^stage-\d+\.\d+\.\d+-[a-f0-9]{12}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(base)){
    throw new Error('MACHINE_UPDATE_UNTRUSTED_STAGING_PATH');
  }
}

/** A pre-existing versioned directory has no proven relationship to the
 * verified official release ZIP. Refuse silent reuse rather than upgrading
 * permissions on and executing arbitrary/stale installed JavaScript. */
export async function assertFreshMachineUpdateTarget(target:string):Promise<void>{
  try{
    await fs.lstat(target);
  }catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')return;
    throw error;
  }
  throw new Error('MACHINE_UPDATE_EXISTING_TARGET_UNATTESTED');
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
      fetchBuffer(base + '/SHA256SUMS-Windows',MAX_RELEASE_CHECKSUM_BYTES),
      fetchBuffer(base + '/Nexowire-Setup.cmd',MAX_RELEASE_SETUP_BYTES),
      fetchBuffer(base + '/Nexowire-Windows-x64.zip',MAX_RELEASE_ZIP_BYTES),
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
  // A valid node.exe and cli.js pathname does not attest the full JS tree
  // to the downloaded/verified archive. Never silently reuse it.
  await assertFreshMachineUpdateTarget(target);

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
  assertMachineUpdateOwnedStage(root,staging);
  let stageError:unknown;
  try {
    await fs.mkdir(extract, { recursive: true });
    await fs.writeFile(zipFile, zipBuffer);

  const script = renderBoundedWindowsArchiveExtraction(zipFile,extract);
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
  // A concurrent target creation is a collision, not proof that some
  // already present runtime is the same official release. Fail closed.
  await assertFreshMachineUpdateTarget(target);
  await fs.rename(source,target);
    hardenAcl(target);
    return target;
  } catch(error) {
    stageError=error;
    throw error;
  } finally {
    // Remove the uniquely owned staging subtree on success OR failure.
    // Refuse recursion if the protected tree has become unsafe, including
    // a reparse/junction entry introduced after the initial preflight.
    try {
      assertMachineUpdateOwnedStage(root,staging);
      assertMachineUpdateTreeProtectedBeforeWrite();
      await fs.rm(staging,{recursive:true,force:true,maxRetries:2,retryDelay:200});
    } catch(cleanupError) {
      if(stageError!==undefined){
        throw new AggregateError([stageError,cleanupError],
          'MACHINE_UPDATE_STAGE_AND_CLEANUP_FAILED');
      }
      throw cleanupError;
    }
  }
}

export function trustedMachineUpdateCutoverTarget(input: {
  targetRoot: string;
  version: string;
  buildId: string;
}): string {
  const parsed=validateInput(input);
  if(parsed.version!==input.version || parsed.buildId!==input.buildId){
    throw new Error('MACHINE_UPDATE_CUTOVER_ID_MISMATCH');
  }
  const expected=path.win32.join(programDataRoot(),'versions',parsed.buildId);
  // Only the exact staged version path produced by this updater is eligible.
  // Reject case tricks, traversal, aliases, device/UNC syntax, extra
  // descendants and other build ids before rendering any launcher mutation.
  if(typeof input.targetRoot!=='string' || input.targetRoot!==expected){
    throw new Error('MACHINE_UPDATE_UNTRUSTED_CUTOVER_TARGET');
  }
  return expected;
}

export function renderMachineCutoverScript(input: {
  targetRoot: string;
  version: string;
  buildId: string;
}): string {
  const targetRoot=trustedMachineUpdateCutoverTarget(input);
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
    '$NewRoot=' + psLiteral(targetRoot),
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
    '  if(-not(Test-Path -LiteralPath $file -PathType Leaf)){throw (\'MACHINE_UPDATE_LAUNCHER_MISSING: \'+$file)}',
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
    'function Assert-CutoverPlan {',
    '  if(-not $hasBoot -and -not $hasBroker){throw \'MACHINE_UPDATE_NO_ELIGIBLE_TASKS\'}',
    '  if($hasBoot -and -not(Test-Path -LiteralPath $BootLauncher -PathType Leaf)){throw \'MACHINE_UPDATE_HUB_LAUNCHER_MISSING\'}',
    '  if($hasBroker -and -not(Test-Path -LiteralPath $BrokerLauncher -PathType Leaf)){throw \'MACHINE_UPDATE_BROKER_LAUNCHER_MISSING\'}',
    '}',
    'function Wait-Service([int]$port,[string]$needle,[int]$seconds){$expectedExe=[IO.Path]::Combine($NewRoot,"runtime","node.exe");$expectedCli=[IO.Path]::Combine($NewRoot,"app","dist","src","cli.js");$until=(Get-Date).AddSeconds($seconds);while((Get-Date)-lt$until){foreach($socket in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)){if(!$socket -or [int]$socket.OwningProcess -le 0){continue};$p=Get-CimInstance Win32_Process -Filter ("ProcessId="+[int]$socket.OwningProcess) -ErrorAction SilentlyContinue;if($p -and $p.Name -ieq "node.exe" -and $p.ExecutablePath -ieq $expectedExe -and $p.CommandLine -match [regex]::Escape($expectedCli) -and $p.CommandLine -match $needle){return $true}};Start-Sleep -Milliseconds 500};return $false}',
    'function Write-Status([string]$state,[string]$message=$null){[ordered]@{state=$state;version=$Version;buildId=$BuildId;targetRoot=$NewRoot;updatedAt=(Get-Date).ToUniversalTime().ToString(\'o\');error=$message}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $Status -Encoding UTF8}',
    'Start-Sleep -Seconds 3',
    '$hasBoot=Task-Exists $BootTask',
    '$hasBroker=Task-Exists $BrokerTask',
    'try {',
    '  Assert-CutoverPlan',
    '  if($hasBoot){Patch-Launcher $BootLauncher}',
    '  if($hasBroker){Patch-Launcher $BrokerLauncher}',
    '  if($hasBoot){Stop-ScheduledTask -TaskName $BootTask -ErrorAction SilentlyContinue}',
    '  if($hasBroker){Stop-ScheduledTask -TaskName $BrokerTask -ErrorAction SilentlyContinue}',
    '  Start-Sleep -Seconds 1',
    '  if($hasBoot){Start-ScheduledTask -TaskName $BootTask; if(-not(Wait-Service 43110 \'cli\\.js"?\\s+http(?:\\s|$)\' 30)){throw \'Updated SYSTEM Hub did not bind 43110 from the new runtime\'}}',
    '  if($hasBroker){Start-ScheduledTask -TaskName $BrokerTask; if(-not(Wait-Service 43112 \'privileged-broker\\s+run(?:\\s|$)\' 20)){throw \'Updated Admin Bridge did not bind 43112 from the new runtime\'}}',
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
  // Never stage or recursively change ACLs under a user-writable root.
  assertMachineUpdateTreeProtectedBeforeWrite();
  const targetRoot = await extractVerifiedRuntime(input);
  // Post-stage read-only recheck plus signed native host/import-tree audit.
  assertMachineUpdateTreeProtectedBeforeWrite();
  assertWindowsPrivilegedRuntimeTrusted({
    executable:path.win32.join(targetRoot,'runtime','node.exe'),
    cliEntrypoint:path.win32.join(targetRoot,'app','dist','src','cli.js'),
  });
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
  // No detached cutover can start if the root was substituted after staging.
  assertMachineUpdateTreeProtectedBeforeWrite();

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
