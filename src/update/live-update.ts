import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod';
import { NEXOWIRE_VERSION } from '../version.js';
import type { PrivilegedBrokerClient } from '../agent/privileged-broker-client.js';

const REPOSITORY = 'Naveax/Nexowire';
const LATEST_RELEASE_URL =
  'https://api.github.com/repos/' + REPOSITORY + '/releases/latest';

const UpdateStateSchema = z.object({
  schemaVersion: z.literal(1),
  state: z.enum([
    'idle',
    'checking',
    'staging',
    'cutover_scheduled',
    'succeeded',
    'rolled_back',
    'failed',
  ]),
  currentVersion: z.string(),
  targetVersion: z.string().nullable(),
  buildId: z.string().nullable(),
  targetRoot: z.string().nullable(),
  machineComponentsPending: z.boolean(),
  updatedAt: z.string(),
  error: z.string().nullable(),
});

export type LiveUpdateState = z.infer<typeof UpdateStateSchema>;

export interface ReleaseInfo {
  version: string;
  tag: string;
  htmlUrl: string;
  publishedAt: string | null;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  release: ReleaseInfo;
}

export interface LiveUpdateOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  localAppData?: string;
  tempDir?: string;
  privilegedBroker?: PrivilegedBrokerClient;
}

function safeVersion(value: string): string {
  const version = value.trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('Unsupported Nexowire release version: ' + value);
  }
  return version;
}

export function compareReleaseVersions(a: string, b: string): number {
  const left = safeVersion(a).split('.').map(Number);
  const right = safeVersion(b).split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const delta = left[index]! - right[index]!;
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

export function parseWindowsChecksumFile(
  text: string,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([a-fA-F0-9]{64})\s{2}(.+)$/.exec(line.trim());
    if (!match) {
      throw new Error('Invalid Windows checksum line: ' + line);
    }
    result.set(match[2]!, match[1]!.toLowerCase());
  }
  return result;
}

export function parseWindowsSetupMetadata(text: string): {
  version: string;
  buildId: string;
} {
  const version = /set "NX_VERSION=([^"]+)"/i.exec(text)?.[1];
  const buildId = /set "NX_BUILD_ID=([^"]+)"/i.exec(text)?.[1];
  if (!version || !buildId) {
    throw new Error('Nexowire Windows setup metadata is incomplete.');
  }
  const normalized = safeVersion(version);
  if (!new RegExp(
    '^' + normalized.replaceAll('.', '\\.') + '-[a-f0-9]{12}$',
    'i',
  ).test(buildId)) {
    throw new Error('Nexowire Windows build ID is invalid.');
  }
  return { version: normalized, buildId };
}

function localAppData(options: LiveUpdateOptions): string {
  const value =
    options.localAppData ??
    options.env?.LOCALAPPDATA ??
    process.env.LOCALAPPDATA;
  if (!value?.trim()) {
    throw new Error('LOCALAPPDATA is required for Nexowire live update.');
  }
  return path.resolve(value);
}

function updateRoot(options: LiveUpdateOptions): string {
  return path.join(localAppData(options), 'Nexowire', 'update');
}

function statePath(options: LiveUpdateOptions): string {
  return path.join(updateRoot(options), 'status.json');
}

function versionsRoot(options: LiveUpdateOptions): string {
  return path.join(localAppData(options), 'Nexowire', 'versions');
}

function isoNow(): string {
  return new Date().toISOString();
}

async function writeState(
  options: LiveUpdateOptions,
  state: LiveUpdateState,
): Promise<void> {
  const file = statePath(options);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + randomUUID();
  await fs.writeFile(
    temporary,
    JSON.stringify(UpdateStateSchema.parse(state), null, 2) + '\n',
    'utf8',
  );
  await fs.rename(temporary, file);
}

export async function readLiveUpdateState(
  options: LiveUpdateOptions = {},
): Promise<LiveUpdateState> {
  try {
    return UpdateStateSchema.parse(
      JSON.parse(await fs.readFile(statePath(options), 'utf8')),
    );
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return {
        schemaVersion: 1,
        state: 'idle',
        currentVersion: NEXOWIRE_VERSION,
        targetVersion: null,
        buildId: null,
        targetRoot: null,
        machineComponentsPending: false,
        updatedAt: isoNow(),
        error: null,
      };
    }
    throw error;
  }
}

async function fetchChecked(
  url: string,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'Nexowire/' + NEXOWIRE_VERSION,
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(
        'Nexowire update download failed: HTTP ' + response.status,
      );
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkLiveUpdate(
  options: LiveUpdateOptions = {},
): Promise<UpdateCheckResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  await writeState(options, {
    schemaVersion: 1,
    state: 'checking',
    currentVersion: NEXOWIRE_VERSION,
    targetVersion: null,
    buildId: null,
    targetRoot: null,
    machineComponentsPending: false,
    updatedAt: isoNow(),
    error: null,
  });
  const response = await fetchChecked(LATEST_RELEASE_URL, fetchImpl);
  const body = await response.json() as {
    tag_name?: unknown;
    html_url?: unknown;
    published_at?: unknown;
  };
  if (typeof body.tag_name !== 'string') {
    throw new Error('Latest Nexowire release has no tag.');
  }
  const version = safeVersion(body.tag_name);
  const release: ReleaseInfo = {
    version,
    tag: 'v' + version,
    htmlUrl:
      typeof body.html_url === 'string' ? body.html_url : '',
    publishedAt:
      typeof body.published_at === 'string' ? body.published_at : null,
  };
  const result = {
    currentVersion: NEXOWIRE_VERSION,
    latestVersion: version,
    updateAvailable:
      compareReleaseVersions(NEXOWIRE_VERSION, version) < 0,
    release,
  };
  await writeState(options, {
    schemaVersion: 1,
    state: 'idle',
    currentVersion: NEXOWIRE_VERSION,
    targetVersion: version,
    buildId: null,
    targetRoot: null,
    machineComponentsPending: false,
    updatedAt: isoNow(),
    error: null,
  });
  return result;
}

async function sha256(data: Buffer): Promise<string> {
  return createHash('sha256').update(data).digest('hex');
}

function psLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

async function runPowerShell(
  script: string,
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
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
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8').trim();
      const err = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        reject(new Error(err || out || 'PowerShell update step failed.'));
        return;
      }
      resolve({ stdout: out, stderr: err });
    });
  });
}

async function stageWindowsRelease(
  release: ReleaseInfo,
  options: LiveUpdateOptions,
): Promise<{ buildId: string; targetRoot: string }> {
  if (process.platform !== 'win32') {
    throw new Error('Live Windows bundle update currently requires Windows.');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const base =
    'https://github.com/' + REPOSITORY +
    '/releases/download/' + release.tag;
  await writeState(options, {
    schemaVersion: 1,
    state: 'staging',
    currentVersion: NEXOWIRE_VERSION,
    targetVersion: release.version,
    buildId: null,
    targetRoot: null,
    machineComponentsPending: false,
    updatedAt: isoNow(),
    error: null,
  });

  const [sumsResponse, setupResponse, zipResponse] = await Promise.all([
    fetchChecked(base + '/SHA256SUMS-Windows', fetchImpl),
    fetchChecked(base + '/Nexowire-Setup.cmd', fetchImpl),
    fetchChecked(base + '/Nexowire-Windows-x64.zip', fetchImpl),
  ]);
  const sumsText = await sumsResponse.text();
  const setupBuffer = Buffer.from(await setupResponse.arrayBuffer());
  const zipBuffer = Buffer.from(await zipResponse.arrayBuffer());
  const sums = parseWindowsChecksumFile(sumsText);
  const expectedSetup = sums.get('Nexowire-Setup.cmd');
  const expectedZip = sums.get('Nexowire-Windows-x64.zip');
  if (!expectedSetup || !expectedZip) {
    throw new Error('Windows release checksums are incomplete.');
  }
  if (await sha256(setupBuffer) !== expectedSetup) {
    throw new Error('Nexowire setup checksum mismatch.');
  }
  if (await sha256(zipBuffer) !== expectedZip) {
    throw new Error('Nexowire Windows payload checksum mismatch.');
  }
  const setupText = setupBuffer.toString('utf8');
  const metadata = parseWindowsSetupMetadata(setupText);
  if (metadata.version !== release.version) {
    throw new Error('Release tag/setup version mismatch.');
  }

  const targetRoot = path.join(
    versionsRoot(options),
    metadata.buildId,
  );
  const targetCli = path.join(
    targetRoot,
    'app',
    'dist',
    'src',
    'cli.js',
  );
  const targetNode = path.join(targetRoot, 'runtime', 'node.exe');
  try {
    await fs.access(targetCli);
    await fs.access(targetNode);
  } catch {
    const tempRoot = await fs.mkdtemp(
      path.join(options.tempDir ?? os.tmpdir(), 'nexowire-update-'),
    );
    try {
      const zipFile = path.join(tempRoot, 'Nexowire-Windows-x64.zip');
      const extractRoot = path.join(tempRoot, 'extract');
      await fs.writeFile(zipFile, zipBuffer);
      await fs.mkdir(extractRoot, { recursive: true });
      await runPowerShell(
        '$ErrorActionPreference=\'Stop\'; ' +
        'Add-Type -AssemblyName System.IO.Compression.FileSystem; ' +
        '[System.IO.Compression.ZipFile]::ExtractToDirectory(' +
        psLiteral(zipFile) + ', ' + psLiteral(extractRoot) + ');',
      );
      const source = path.join(extractRoot, 'Nexowire');
      await fs.access(path.join(source, 'runtime', 'node.exe'));
      await fs.access(path.join(source, 'app', 'dist', 'src', 'cli.js'));
      await fs.mkdir(path.dirname(targetRoot), { recursive: true });
      try {
        await fs.rename(source, targetRoot);
      } catch (error) {
        try {
          await fs.access(targetRoot);
        } catch {
          throw error;
        }
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }

  const packageJson = JSON.parse(
    await fs.readFile(path.join(targetRoot, 'app', 'package.json'), 'utf8'),
  ) as { version?: unknown };
  if (packageJson.version !== release.version) {
    throw new Error('Staged Nexowire package version mismatch.');
  }
  return { buildId: metadata.buildId, targetRoot };
}

export function renderWindowsCutoverScript(input: {
  targetVersion: string;
  buildId: string;
  targetRoot: string;
  localAppData: string;
}): string {
  const updateDir = path.join(
    input.localAppData,
    'Nexowire',
    'update',
  );
  const statusFile = path.join(updateDir, 'status.json');
  const home = process.env.USERPROFILE ?? os.homedir();
  const agentLauncher = path.join(
    home,
    '.nexowire',
    'native-agent',
    'launch.ps1',
  );
  const hubLauncher = path.join(
    home,
    '.nexowire',
    'hub-service',
    'launch.ps1',
  );
  return [
    "$ErrorActionPreference='Stop'",
    '$TargetVersion=' + psLiteral(input.targetVersion),
    '$BuildId=' + psLiteral(input.buildId),
    '$NewRoot=' + psLiteral(input.targetRoot),
    '$StatusFile=' + psLiteral(statusFile),
    '$AgentLauncher=' + psLiteral(agentLauncher),
    '$HubLauncher=' + psLiteral(hubLauncher),
    '$AgentTask=\'Nexowire Native Agent\'',
    '$HubTask=\'Nexowire Hub\'',
    '$backups=@{}',
    'function Write-State([string]$state,[string]$errorMessage=$null,[bool]$machinePending=$false){',
    '  $obj=[ordered]@{schemaVersion=1;state=$state;currentVersion=$TargetVersion;targetVersion=$TargetVersion;buildId=$BuildId;targetRoot=$NewRoot;machineComponentsPending=$machinePending;updatedAt=(Get-Date).ToUniversalTime().ToString(\'o\');error=$errorMessage}',
    '  $json=$obj|ConvertTo-Json -Depth 5',
    '  $tmp=$StatusFile+\'.tmp\'',
    '  Set-Content -LiteralPath $tmp -Value $json -Encoding UTF8',
    '  Move-Item -LiteralPath $tmp -Destination $StatusFile -Force',
    '}',
    'function Patch-Launcher([string]$file){',
    '  if(-not (Test-Path -LiteralPath $file)){return}',
    '  $text=Get-Content -LiteralPath $file -Raw',
    '  if($text.Contains($NewRoot)){return}',
    "  $pattern=[regex]::Escape((Join-Path $env:LOCALAPPDATA 'Nexowire\\versions'))+'\\\\[^''\"\\r\\n]+'",
    '  $match=[regex]::Match($text,$pattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase)',
    '  if(-not $match.Success){throw (\'Could not find versioned Nexowire runtime in launcher: \'+$file)}',
    '  $backup=$file+\'.update-rollback\'',
    '  Copy-Item -LiteralPath $file -Destination $backup -Force',
    '  $backups[$file]=$backup',
    '  Set-Content -LiteralPath $file -Value ($text.Replace($match.Value,$NewRoot)) -Encoding UTF8',
    '}',
    'function Restore-Launchers {',
    '  foreach($entry in $backups.GetEnumerator()){Copy-Item -LiteralPath $entry.Value -Destination $entry.Key -Force}',
    '}',
    'function Task-Exists([string]$name){return $null -ne (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue)}',
    'function Wait-Port([int]$port,[int]$seconds){$until=(Get-Date).AddSeconds($seconds);while((Get-Date)-lt $until){if(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue){return $true};Start-Sleep -Milliseconds 500};return $false}',
    'function Wait-Agent([int]$seconds){$until=(Get-Date).AddSeconds($seconds);while((Get-Date)-lt $until){$p=Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" -ErrorAction SilentlyContinue|Where-Object{$_.CommandLine -match [regex]::Escape($NewRoot) -and $_.CommandLine -match \'cli\\.js agent run\'};if($p){return $true};Start-Sleep -Milliseconds 500};return $false}',
    'Start-Sleep -Seconds 2',
    "$HubBootTask='Nexowire Hub Boot'",
    '$hubBootInstalled=Task-Exists $HubBootTask',
    '$hadAgent=Task-Exists $AgentTask',
    '$hadHub=(Task-Exists $HubTask) -and -not $hubBootInstalled',
    'try {',
    '  if($hadAgent){Stop-ScheduledTask -TaskName $AgentTask -ErrorAction SilentlyContinue}',
    '  if($hadHub){Stop-ScheduledTask -TaskName $HubTask -ErrorAction SilentlyContinue}',
    '  Start-Sleep -Seconds 1',
    '  Patch-Launcher $AgentLauncher',
    '  Patch-Launcher $HubLauncher',
    '  if($hadHub){Start-ScheduledTask -TaskName $HubTask; if(-not (Wait-Port 43110 25)){throw \'Updated Hub did not become healthy on 43110\'}}',
    '  if($hadAgent){Start-ScheduledTask -TaskName $AgentTask; if(-not (Wait-Agent 25)){throw \'Updated Agent did not start from the new runtime\'}}',
    '  $machinePending=(Task-Exists \'Nexowire Hub Boot\') -or (Task-Exists \'Nexowire Privileged Broker\')',
    '  Write-State \'succeeded\' $null $machinePending',
    '} catch {',
    '  $message=$_.Exception.Message',
    '  if($hadAgent){Stop-ScheduledTask -TaskName $AgentTask -ErrorAction SilentlyContinue}',
    '  if($hadHub){Stop-ScheduledTask -TaskName $HubTask -ErrorAction SilentlyContinue}',
    '  Restore-Launchers',
    '  if($hadHub){Start-ScheduledTask -TaskName $HubTask -ErrorAction SilentlyContinue}',
    '  Start-Sleep -Seconds 2',
    '  if($hadAgent){Start-ScheduledTask -TaskName $AgentTask -ErrorAction SilentlyContinue}',
    '  Write-State \'rolled_back\' $message $false',
    '  exit 1',
    '}',
    '',
  ].join('\r\n');
}

export async function applyLatestLiveUpdate(
  options: LiveUpdateOptions = {},
): Promise<{
  scheduled: boolean;
  currentVersion: string;
  targetVersion: string;
  buildId?: string;
  targetRoot?: string;
}> {
  const check = await checkLiveUpdate(options);
  if (!check.updateAvailable) {
    return {
      scheduled: false,
      currentVersion: NEXOWIRE_VERSION,
      targetVersion: check.latestVersion,
    };
  }
  if (process.platform !== 'win32') {
    throw new Error(
      'Live apply is currently implemented for Windows bundles only.',
    );
  }
  try {
    const staged = await stageWindowsRelease(check.release, options);
    let machineComponentsPending = false;
    const broker = options.privilegedBroker;
    if (broker) {
      const probe = await broker.probe();
      if (
        probe.reachable &&
        probe.elevated &&
        probe.version !== check.latestVersion
      ) {
        machineComponentsPending = true;
        try {
          await broker.execute(
            'nexowire.machine_update.apply',
            {
              version: check.latestVersion,
              buildId: staged.buildId,
            },
          );
        } catch {
          // v1.0.3 and older brokers do not know the machine
          // update capability. User-level cutover can still
          // complete; status remains explicit until the one-time
          // Admin Bridge upgrade is performed.
        }
      } else if (!probe.reachable || !probe.elevated) {
        machineComponentsPending = true;
      }
    }
    const root = updateRoot(options);
    await fs.mkdir(root, { recursive: true });
    const helper = path.join(
      root,
      'apply-' + staged.buildId + '.ps1',
    );
    await fs.writeFile(
      helper,
      renderWindowsCutoverScript({
        targetVersion: check.latestVersion,
        buildId: staged.buildId,
        targetRoot: staged.targetRoot,
        localAppData: localAppData(options),
      }),
      'utf8',
    );
    await writeState(options, {
      schemaVersion: 1,
      state: 'cutover_scheduled',
      currentVersion: NEXOWIRE_VERSION,
      targetVersion: check.latestVersion,
      buildId: staged.buildId,
      targetRoot: staged.targetRoot,
      machineComponentsPending,
      updatedAt: isoNow(),
      error: null,
    });
    const child = spawn(
      'powershell.exe',
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
        stdio: 'ignore',
      },
    );
    child.unref();
    return {
      scheduled: true,
      currentVersion: NEXOWIRE_VERSION,
      targetVersion: check.latestVersion,
      buildId: staged.buildId,
      targetRoot: staged.targetRoot,
    };
  } catch (error) {
    await writeState(options, {
      schemaVersion: 1,
      state: 'failed',
      currentVersion: NEXOWIRE_VERSION,
      targetVersion: check.latestVersion,
      buildId: null,
      targetRoot: null,
      machineComponentsPending: false,
      updatedAt: isoNow(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function executeLiveUpdateCapability(
  capability: string,
  input: unknown,
  options: LiveUpdateOptions = {},
): Promise<unknown> {
  if (
    input !== undefined &&
    input !== null &&
    (typeof input !== 'object' || Array.isArray(input))
  ) {
    throw new Error('Update capability input must be an object.');
  }
  switch (capability) {
    case 'nexowire.update.status': {
      let state = await readLiveUpdateState(options);
      if (
        state.machineComponentsPending &&
        state.targetVersion &&
        options.privilegedBroker
      ) {
        const probe =
          await options.privilegedBroker.probe();
        if (
          probe.reachable &&
          probe.elevated &&
          probe.version === state.targetVersion
        ) {
          state = {
            ...state,
            machineComponentsPending: false,
            updatedAt: isoNow(),
          };
          await writeState(options, state);
        }
      }
      return { data: state };
    }
    case 'nexowire.update.check':
      return { data: await checkLiveUpdate(options) };
    case 'nexowire.update.apply':
      return {
        data: await applyLatestLiveUpdate(options),
      };
    default:
      throw new Error('Unsupported live update capability: ' + capability);
  }
}

export async function runLiveUpdateCommand(
  args: readonly string[],
): Promise<void> {
  const action = args[0] ?? 'status';
  let output: unknown;
  if (action === 'status') {
    output = await readLiveUpdateState();
  } else if (action === 'check') {
    output = await checkLiveUpdate();
  } else if (action === 'apply') {
    output = await applyLatestLiveUpdate();
  } else {
    throw new Error(
      'Usage: nexowire update [status|check|apply]',
    );
  }
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}
