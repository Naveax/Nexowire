import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as z from 'zod';

const WINDOWS_TASK_DEFAULT = 'Nexowire Native Agent';
// A persistent interactive agent must not silently inherit Windows Scheduler's
// AC-only defaults: a laptop/UPS transitioning to battery is still enrolled.
export const WINDOWS_NATIVE_AGENT_TASK_SETTINGS =
  '$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries';
const AGENT_TASK_SYSTEM32='C:\\Windows\\System32';
const AGENT_TASK_POWERSHELL=AGENT_TASK_SYSTEM32+'\\WindowsPowerShell\\v1.0\\powershell.exe';
const AGENT_TASK_MODULES=AGENT_TASK_SYSTEM32+'\\WindowsPowerShell\\v1.0\\Modules';
const AGENT_TASK_SCRIPT_HEADER=String.raw`
$ErrorActionPreference='Stop'
$env:PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
Import-Module -Name 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\ScheduledTasks\ScheduledTasks.psd1' -ErrorAction Stop
`;

/** Native-agent task controller, never pass caller PATH/modules/Node hooks. */
export function isolatedNativeAgentTaskEnv(input:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
  const name=input.NEXOWIRE_AGENT_TASK_NAME;
  const launcher=input.NEXOWIRE_AGENT_LAUNCHER;
  if(!name||name.length>128||!launcher||launcher.length>4096){
    throw new Error('NATIVE_AGENT_TASK_ENV_INVALID');
  }
  return {
    SystemRoot:'C:\\Windows',windir:'C:\\Windows',
    ComSpec:AGENT_TASK_SYSTEM32+'\\cmd.exe',
    PATH:AGENT_TASK_SYSTEM32+';C:\\Windows',
    PSModulePath:AGENT_TASK_MODULES,
    NEXOWIRE_AGENT_TASK_NAME:name,
    NEXOWIRE_AGENT_LAUNCHER:launcher,
    ...(input.NEXOWIRE_AGENT_JOB_HELPER ? {NEXOWIRE_AGENT_JOB_HELPER:input.NEXOWIRE_AGENT_JOB_HELPER} : {}),
    ...(input.NEXOWIRE_AGENT_EXECUTABLE ? {NEXOWIRE_AGENT_EXECUTABLE:input.NEXOWIRE_AGENT_EXECUTABLE} : {}),
    ...(input.NEXOWIRE_AGENT_CLI ? {NEXOWIRE_AGENT_CLI:input.NEXOWIRE_AGENT_CLI} : {}),
  };
}

const LINUX_UNIT_DEFAULT = 'nexowire-agent.service';
const MAC_LABEL_DEFAULT = 'com.nexowire.agent';

const PERSISTED_ENV_NAMES = [
  'NEXOWIRE_HUB_WS_URL',
  'NEXOWIRE_HUB_WS_URLS',
  'NEXOWIRE_DEVICE_NAME',
  'NEXOWIRE_WINDOWS_PRELOGIN_AGENT',
  'NEXOWIRE_AGENT_IDENTITY_FILE',
  'NEXOWIRE_ALLOWED_ROOTS',
  'NEXOWIRE_STATE_DIR',
  'NEXOWIRE_PROCESS_STATE_FILE',
  'NEXOWIRE_PROCESS_WORKER_ROOT',
  'NEXOWIRE_TASK_GRAPH_STATE_FILE',
  'NEXOWIRE_RUNBOOK_STATE_FILE',
  'NEXOWIRE_AGENT_OPERATION_JOURNAL_FILE',
  'NEXOWIRE_AGENT_HEARTBEAT_MS',
  'NEXOWIRE_AGENT_TOKEN_FILE',
  'NEXOWIRE_CORE_AUTHORITY_URL',
  'NEXOWIRE_CORE_APPROVAL_MODE',
  'NEXOWIRE_AGENT_TOKEN_DPAPI_FILE',
  'NEXOWIRE_AGENT_TOKEN_PLATFORM_NAME',
  'NEXOWIRE_PRIVILEGE_MODE',
  'NEXOWIRE_PRIVILEGED_BROKER_URL',
  'NEXOWIRE_PRIVILEGED_BROKER_SECRET_FILE',
] as const;

const FORBIDDEN_INLINE_SECRET_NAMES = [
  'NEXOWIRE_AGENT_TOKEN',
  'NEXOWIRE_AGENT_TOKENS',
  'NEXOWIRE_PRIVILEGED_BROKER_TOKEN',
  'NEXOWIRE_PRIVILEGED_BROKER_TOKENS',
] as const;

const StatusSchema = z.object({
  installed: z.boolean(),
  platform: z.enum(['win32', 'linux', 'darwin']),
  name: z.string(),
  state: z.string(),
  autostart: z.boolean(),
  pid: z.number().int().nonnegative().nullable(),
  launcher: z.string(),
  definition: z.string(),
});

export type NativeAgentLifecycleStatus = z.infer<typeof StatusSchema>;

export interface NativeAgentLifecycleOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cliEntrypoint?: string;
  execPath?: string;
  execArgv?: readonly string[];
  rootDir?: string;
  homeDir?: string;
  windowsTaskName?: string;
  /** Fixed, bundled native Job guardian; used for installed Windows task only. */
  windowsTaskJobOwnerPath?: string;
  /** Only for protected pre-login Agent: keep Job status markers in machine-owned state, not installation root. */
  windowsTaskJobStatusDir?: string;
  linuxUnitName?: string;
  macLabel?: string;
  uid?: number;
}

function platformOf(
  options: NativeAgentLifecycleOptions,
): 'win32' | 'linux' | 'darwin' {
  const platform = options.platform ?? process.platform;
  if (
    platform === 'win32' ||
    platform === 'linux' ||
    platform === 'darwin'
  ) {
    return platform;
  }
  throw new Error(
    'Native-agent install/autostart lifecycle supports Windows, Linux, and macOS.',
  );
}

function trim(value: string | undefined): string | undefined {
  const out = value?.trim();
  return out ? out : undefined;
}

function lifecycleRoot(
  options: NativeAgentLifecycleOptions,
): string {
  return (
    options.rootDir ??
    path.join(
      options.homeDir ?? os.homedir(),
      '.nexowire',
      'native-agent',
    )
  );
}

function launcherPath(
  options: NativeAgentLifecycleOptions,
  platform: 'win32' | 'linux' | 'darwin',
): string {
  if (platform !== 'win32') {
    return path.posix.join(
      lifecycleRoot(options).replaceAll(path.win32.sep, '/'),
      'launch.sh',
    );
  }
  return path.join(lifecycleRoot(options), 'launch.ps1');
}

function manifestPath(
  options: NativeAgentLifecycleOptions,
): string {
  return path.join(lifecycleRoot(options), 'lifecycle.json');
}

function windowsTaskName(
  options: NativeAgentLifecycleOptions,
): string {
  const value =
    options.windowsTaskName ??
    options.env?.NEXOWIRE_AGENT_TASK_NAME ??
    WINDOWS_TASK_DEFAULT;
  const name = value.trim();
  if (!name || name.length > 128) {
    throw new Error(
      'Native-agent scheduled-task name must be 1-128 characters.',
    );
  }
  return name;
}

function linuxUnitName(
  options: NativeAgentLifecycleOptions,
): string {
  const value =
    options.linuxUnitName ??
    options.env?.NEXOWIRE_AGENT_SYSTEMD_UNIT ??
    LINUX_UNIT_DEFAULT;
  const name = value.trim();
  if (
    !/^[A-Za-z0-9_.@-]+\.service$/.test(name) ||
    name.length > 128
  ) {
    throw new Error(
      'Native-agent systemd unit name must be a safe *.service name.',
    );
  }
  return name;
}

function linuxUnitPath(
  options: NativeAgentLifecycleOptions,
): string {
  return path.posix.join(
    (options.homeDir ?? os.homedir()).replaceAll(path.win32.sep, '/'),
    '.config',
    'systemd',
    'user',
    linuxUnitName(options),
  );
}

function macLabel(
  options: NativeAgentLifecycleOptions,
): string {
  const value =
    options.macLabel ??
    options.env?.NEXOWIRE_AGENT_LAUNCHD_LABEL ??
    MAC_LABEL_DEFAULT;
  const label = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(label)) {
    throw new Error('Native-agent launchd label is invalid.');
  }
  return label;
}

function macPlistPath(
  options: NativeAgentLifecycleOptions,
): string {
  return path.posix.join(
    (options.homeDir ?? os.homedir()).replaceAll(path.win32.sep, '/'),
    'Library',
    'LaunchAgents',
    macLabel(options) + '.plist',
  );
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function runtime(
  options: NativeAgentLifecycleOptions,
): { executable: string; args: string[] } {
  const cliEntrypoint =
    options.cliEntrypoint ?? process.argv[1];
  if (!cliEntrypoint) {
    throw new Error(
      'Cannot determine Nexowire CLI entrypoint for native-agent lifecycle.',
    );
  }
  return {
    executable: options.execPath ?? process.execPath,
    args: [
      ...(options.execArgv ?? process.execArgv),
      cliEntrypoint,
      'agent',
      'run',
    ],
  };
}

export function persistedNativeAgentEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  for (const name of FORBIDDEN_INLINE_SECRET_NAMES) {
    if (trim(env[name])) {
      throw new Error(
        'Native-agent lifecycle refuses to persist plaintext secret variable ' +
          name +
          '. Use a mounted file, DPAPI file, platform secret item, or the default protected broker secret.',
      );
    }
  }

  const result: Record<string, string> = {};
  for (const name of PERSISTED_ENV_NAMES) {
    const value = trim(env[name]);
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function psLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function shLiteral(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

export function buildNativeAgentLauncher(
  options: NativeAgentLifecycleOptions = {},
): string {
  const platform = platformOf(options);
  const env = persistedNativeAgentEnvironment(
    options.env ?? process.env,
  );
  const rt = runtime(options);

  if (platform === 'win32') {
    const lines = [
      "$ErrorActionPreference='Stop'",
      "$ProgressPreference='SilentlyContinue'",
    ];
    for (const [name, value] of Object.entries(env).sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      lines.push('$env:' + name + '=' + psLiteral(value));
    }
    if (options.windowsTaskJobOwnerPath) {
      // Scheduled Task kills the PowerShell parent, not necessarily its Node
      // child. The native guardian pins the PowerShell HANDLE and owns a
      // KILL_ON_JOB_CLOSE Job containing Node and all its descendants.
      if (!path.win32.isAbsolute(options.windowsTaskJobOwnerPath)) {
        throw new Error('NATIVE_AGENT_TASK_JOB_HELPER_PATH_UNCONFIRMED');
      }
      const statusDir=options.windowsTaskJobStatusDir;
      if(statusDir && (!path.win32.isAbsolute(statusDir) ||
          statusDir.startsWith('\\\\') || statusDir.startsWith('\\\\?\\'))){
        throw new Error('NATIVE_AGENT_TASK_JOB_STATUS_PATH_UNTRUSTED');
      }
      lines.push(
        '# NEXOWIRE_AGENT_TASK_JOB_GUARD_V1',
        '$jobHelper=' + psLiteral(options.windowsTaskJobOwnerPath),
        "if (-not (Test-Path -LiteralPath $jobHelper -PathType Leaf)) { throw 'NATIVE_AGENT_TASK_JOB_HELPER_UNAVAILABLE' }",
        "$jobMarker=Join-Path " + (statusDir?psLiteral(statusDir):'$PSScriptRoot') + " ('agent-job-'+[guid]::NewGuid().ToString('N')+'.status')",
        '& $jobHelper ' +
          "'--status' $jobMarker '--cwd' '-' '--parent' ([string]$PID) '--' " +
          [rt.executable, ...rt.args].map(psLiteral).join(' '),
        'if ($null -eq $LASTEXITCODE) { exit 70 }',
        'exit $LASTEXITCODE',
        '',
      );
    } else {
      // Standalone launcher rendering for legacy/synthetic consumers only.
      // installWindows always supplies a pinned guardian and fails if missing.
      lines.push(
        '& ' + psLiteral(rt.executable) + ' ' +
          rt.args.map(psLiteral).join(' '),
        'exit $LASTEXITCODE',
        '',
      );
    }
    // This file is executed by Windows PowerShell 5.1, whose BOM-less
    // script decoder otherwise uses the machine's ANSI code page.
    return '\uFEFF' + lines.join('\r\n');
  }

  const lines = ['#!/bin/sh', 'set -eu'];
  for (const [name, value] of Object.entries(env).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    lines.push('export ' + name + '=' + shLiteral(value));
  }
  lines.push(
    'exec ' +
      [rt.executable, ...rt.args]
        .map(shLiteral)
        .join(' '),
    '',
  );
  return lines.join('\n');
}

export function buildLinuxUserUnit(
  options: NativeAgentLifecycleOptions = {},
): string {
  return [
    '[Unit]',
    'Description=Nexowire Native Agent',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    'ExecStart=/bin/sh ' + launcherPath(options, 'linux'),
    'Restart=always',
    'RestartSec=2',
    'TimeoutStopSec=15',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function buildMacLaunchAgentPlist(
  options: NativeAgentLifecycleOptions = {},
): string {
  const label = macLabel(options);
  const launcher = launcherPath(options, 'darwin');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    '  <string>' + xmlEscape(label) + '</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/sh</string>',
    '    <string>' + xmlEscape(launcher) + '</string>',
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

async function runCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  allowFailure = false,
  trustedWindowsTask = false,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      windowsHide: true,
      shell:false,
      ...(trustedWindowsTask?{cwd:AGENT_TASK_SYSTEM32,timeout:60_000}:{}),
      env: trustedWindowsTask?env:{ ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      const result = {
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8').trim(),
        stderr: Buffer.concat(stderr).toString('utf8').trim(),
      };
      if (!allowFailure && result.code !== 0) {
        reject(
          new Error(
            result.stderr ||
              result.stdout ||
              command + ' exited with code ' + result.code,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}

async function runPowerShellJson<T>(
  script: string,
  env: NodeJS.ProcessEnv,
): Promise<T> {
  const result = await runCommand(
    AGENT_TASK_POWERSHELL,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      AGENT_TASK_SCRIPT_HEADER+'\n'+script,
    ],
    isolatedNativeAgentTaskEnv(env),
    false,
    true,
  );
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(
      'Native-agent scheduled-task command returned invalid JSON.',
    );
  }
}

function windowsEnv(
  options: NativeAgentLifecycleOptions,
): NodeJS.ProcessEnv {
  return {
    ...(options.env ?? process.env),
    NEXOWIRE_AGENT_TASK_NAME: windowsTaskName(options),
    NEXOWIRE_AGENT_LAUNCHER: launcherPath(options, 'win32'),
    NEXOWIRE_AGENT_JOB_HELPER: bundledNativeAgentJobHelper(options),
    NEXOWIRE_AGENT_EXECUTABLE: runtime(options).executable,
    NEXOWIRE_AGENT_CLI: options.cliEntrypoint ?? process.argv[1],
  };
}

async function windowsStatus(
  options: NativeAgentLifecycleOptions,
): Promise<NativeAgentLifecycleStatus> {
  const result = await runPowerShellJson<{
    installed: boolean;
    state: string;
  }>(
    [
      "$ErrorActionPreference='Stop'",
      '$name=$env:NEXOWIRE_AGENT_TASK_NAME',
      '$task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue',
      'if ($null -eq $task) {',
      "  [pscustomobject]@{installed=$false;state='not-installed'} | ConvertTo-Json -Compress",
      '  exit 0',
      '}',
      "[pscustomobject]@{installed=$true;state=([string]$task.State).ToLowerInvariant()} | ConvertTo-Json -Compress",
    ].join('\n'),
    windowsEnv(options),
  );
  return StatusSchema.parse({
    installed: result.installed,
    platform: 'win32',
    name: windowsTaskName(options),
    state: result.state,
    autostart: result.installed,
    pid: null,
    launcher: launcherPath(options, 'win32'),
    definition: windowsTaskName(options),
  });
}

function bundledNativeAgentJobHelper(options: NativeAgentLifecycleOptions): string {
  const entry = options.cliEntrypoint ?? process.argv[1];
  if (!entry || !path.win32.isAbsolute(entry)) {
    throw new Error('NATIVE_AGENT_TASK_CLI_PATH_UNCONFIRMED');
  }
  // Source: src/cli.ts -> native/. Bundle: dist/src/cli.js -> dist/native/.
  // Never accept PATH, a free-form environment override or global helpers.
  return path.win32.resolve(
    path.win32.dirname(entry), '..', 'native', 'windows-job-owner.exe',
  );
}

async function assertNoResidualWindowsTaskOwnerArtifacts(root: string): Promise<void> {
  let files: string[];
  try {
    files = await fs.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (files.some((file) =>
    file === 'launch.ps1' ||
    file === 'agent-job-retention.lock' ||
    file.startsWith('agent-job-'))) {
    throw new Error('NATIVE_AGENT_TASK_RESIDUAL_OWNER_UNCONFIRMED');
  }
}

/** An unregistered task is not proof that its former guardian/Node exited. */
export { assertNoResidualWindowsTaskOwnerArtifacts };

async function installWindows(
  options: NativeAgentLifecycleOptions,
): Promise<NativeAgentLifecycleStatus> {
  const root = lifecycleRoot(options);
  const launcher = launcherPath(options, 'win32');
  const helper = bundledNativeAgentJobHelper(options);
  if (!(await fs.stat(helper).catch(() => null))?.isFile()) {
    throw new Error('NATIVE_AGENT_TASK_JOB_HELPER_UNAVAILABLE');
  }
  // Do not overwrite a running legacy task: its unmanaged Node descendant
  // might survive Register-ScheduledTask -Force and collide with new Agent.
  const existing = await windowsStatus(options);
  if (existing.installed) {
    // Legacy tasks have no child-ownership evidence even when Scheduler says
    // Ready. Explicit migration is required; never assume no orphan exists.
    const prior = await windowsAgentTaskOwnerReadback(options);
    if (!prior.guarded || prior.receipts === 0 ||
        prior.liveRoots !== 0 || prior.liveGuardians !== 0 ||
        prior.state === 'running') {
      throw new Error('NATIVE_AGENT_TASK_PREEXISTING_OWNER_UNCONFIRMED');
    }
  } else {
    await assertNoResidualWindowsTaskOwnerArtifacts(root);
  }
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    launcher,
    buildNativeAgentLauncher({
      ...options,
      platform: 'win32',
      windowsTaskJobOwnerPath: helper,
    }),
    { encoding: 'utf8', mode: 0o600 },
  );

  const script = [
    "$ErrorActionPreference='Stop'",
    '$name=$env:NEXOWIRE_AGENT_TASK_NAME',
    '$launcher=$env:NEXOWIRE_AGENT_LAUNCHER',
    '$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name',
    '$argument=\'-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "\' + $launcher.Replace(\'"\',\'""\') + \'"\'',
    "$action=New-ScheduledTaskAction -Execute 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -Argument $argument",
    '$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user',
    '$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited',
    WINDOWS_NATIVE_AGENT_TASK_SETTINGS,
    "Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Nexowire first-party native agent' -Force | Out-Null",
    '[pscustomobject]@{ok=$true} | ConvertTo-Json -Compress',
  ].join('\n');

  await runPowerShellJson<{ ok: boolean }>(
    script,
    windowsEnv(options),
  );
  await writeManifest(options, 'win32');
  // Install is not successful until Job-owned Node has a matching OS receipt.
  return await controlWindows('start', options);
}

export interface WindowsAgentTaskOwnerReadback {
  installed: boolean;
  state: string;
  guarded: boolean;
  receipts: number;
  liveRoots: number;
  liveGuardians: number;
  rootPid: number | null;
  /** A process with Agent CLI args but no currently attested Job owner. */
  unknownAgentNodes: number;
}

/**
 * Independent OS readback for Scheduler and the native guardian. Never
 * equate TaskState=Ready with descendant death. The NWJOB3 marker pins
 * the assigned root's PID *and* Win32 creation FILETIME; PID reuse is not
 * a live-owner match. Unknown CIM, malformed evidence and access denial
 * must throw rather than silently authorize the next Agent.
 */
export const WINDOWS_AGENT_TASK_OWNER_READBACK_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$name=$env:NEXOWIRE_AGENT_TASK_NAME
$launcher=$env:NEXOWIRE_AGENT_LAUNCHER
$task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($null -eq $task) {
  [pscustomobject]@{installed=$false;state='not-installed';guarded=$false;receipts=0;liveRoots=0;liveGuardians=0;rootPid=$null;unknownAgentNodes=0} | ConvertTo-Json -Compress
  exit 0
}
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'NATIVE_AGENT_TASK_LAUNCHER_MISSING' }
$guarded=[IO.File]::ReadAllText($launcher).Contains('# NEXOWIRE_AGENT_TASK_JOB_GUARD_V1')
if (-not $guarded) { throw 'NATIVE_AGENT_TASK_JOB_GUARD_REQUIRED' }
# PS5.1 does not support Split-Path -LiteralPath with -Parent.
# Resolve only a rooted launcher path; never infer ownership from cwd.
if (-not [IO.Path]::IsPathRooted($launcher)) { throw 'NATIVE_AGENT_TASK_LAUNCHER_PATH_UNSAFE' }
$dir=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($launcher))
if ([string]::IsNullOrWhiteSpace($dir)) { throw 'NATIVE_AGENT_TASK_LAUNCHER_PARENT_UNCONFIRMED' }
$expectedHelper=$env:NEXOWIRE_AGENT_JOB_HELPER
$expectedNode=$env:NEXOWIRE_AGENT_EXECUTABLE
$expectedCli=$env:NEXOWIRE_AGENT_CLI
if (-not $expectedHelper -or -not $expectedNode -or -not $expectedCli) { throw 'NATIVE_AGENT_TASK_OWNER_PATH_UNKNOWN' }
if (-not [IO.Path]::IsPathRooted($expectedHelper) -or -not [IO.Path]::IsPathRooted($expectedNode) -or -not [IO.Path]::IsPathRooted($expectedCli)) { throw 'NATIVE_AGENT_TASK_OWNER_PATH_UNSAFE' }
# Resolve Windows 8.3 short/long executable aliases before establishing ownership.
# Never widen owner scope beyond the pinned absolute binary and root paths.
$expectedHelper=[IO.Path]::GetFullPath($expectedHelper)
$expectedNode=[IO.Path]::GetFullPath($expectedNode)
$lockPath=Join-Path $dir 'agent-job-retention.lock'
$lock=$null
# Serialize independent Agent control readbacks; a lock failure never authorizes restart or deletion.
for ($attempt=0; $attempt -lt 25; $attempt++) {
  try { $lock=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); break }
  catch [IO.IOException] { Start-Sleep -Milliseconds 80 }
}
if ($null -eq $lock) { throw 'NATIVE_AGENT_TASK_RETENTION_LOCK_UNAVAILABLE' }
try {
  $markers=@(Get-ChildItem -LiteralPath $dir -Filter 'agent-job-*.status' -File -ErrorAction Stop)
  # Bound untrusted filesystem work. Normal housekeeping removes only proved-dead receipts,
  # so the historical 128 count no longer acts as a permanent 129th-start failure.
  if ($markers.Count -gt 16384) { throw 'NATIVE_AGENT_TASK_RECEIPT_SCAN_LIMIT_EXCEEDED' }
  $guardianProcesses=@(Get-CimInstance Win32_Process -Filter "Name='windows-job-owner.exe'" -ErrorAction Stop)
  $nodes=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)
  $ownedGuardians=@()
  foreach ($g in $guardianProcesses) {
    if (-not $g.ExecutablePath -or -not $g.CommandLine) { throw 'NATIVE_AGENT_TASK_GUARDIAN_IDENTITY_UNKNOWN' }
    if (-not [IO.Path]::IsPathRooted([string]$g.ExecutablePath)) { throw 'NATIVE_AGENT_TASK_GUARDIAN_BINARY_PATH_UNSAFE' }
    $guardianBinary=[IO.Path]::GetFullPath([string]$g.ExecutablePath)
    if ([string]::Equals($guardianBinary,$expectedHelper,[StringComparison]::OrdinalIgnoreCase)) {
      $ownedGuardians+=,$g
      continue
    }
    # A different binary advertising THIS protected receipt directory is
    # ambiguous, even if a reparse/realpath alias prevents binary equality.
    # Never authorize compaction or stop under that foreign guardian.
    $foreignStatusMatch=[regex]::Match([string]$g.CommandLine,
      '^\s*(?:"[^"]+"|\S+)\s+--status\s+(?:"(?<quoted>[^"]+)"|(?<plain>\S+))(?=\s|$)',
      [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($foreignStatusMatch.Success) {
      $foreignStatus=if ($foreignStatusMatch.Groups['quoted'].Success) {
        $foreignStatusMatch.Groups['quoted'].Value
      } else { $foreignStatusMatch.Groups['plain'].Value }
      if (-not [IO.Path]::IsPathRooted($foreignStatus)) {
        throw 'NATIVE_AGENT_TASK_FOREIGN_GUARDIAN_STATUS_UNCONFIRMED'
      }
      $foreignDir=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($foreignStatus))
      if ([string]::Equals($foreignDir,$dir,[StringComparison]::OrdinalIgnoreCase)) {
        throw 'NATIVE_AGENT_TASK_FOREIGN_GUARDIAN_OWNER_DIR_UNCONFIRMED'
      }
    }
  }
  # Windows CIM may report an 8.3 short path (RUNNER~1), while GetFullPath
  # and the receipt enumeration return the long path. Do not compare raw
  # CommandLine substrings: parse the real guardian's --status argument and
  # canonicalize it against the protected launcher/receipt directory.
  $guardianStatuses=@()
  foreach ($g in $ownedGuardians) {
    $statusMatch=[regex]::Match([string]$g.CommandLine,
      '^\s*(?:"[^"]+"|\S+)\s+--status\s+(?:"(?<quoted>[^"]+)"|(?<plain>\S+))(?=\s|$)',
      [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $statusMatch.Success) { throw 'NATIVE_AGENT_TASK_GUARDIAN_STATUS_ARGUMENT_UNCONFIRMED' }
    $rawStatus=if ($statusMatch.Groups['quoted'].Success) { $statusMatch.Groups['quoted'].Value } else { $statusMatch.Groups['plain'].Value }
    if (-not [IO.Path]::IsPathRooted($rawStatus)) { throw 'NATIVE_AGENT_TASK_GUARDIAN_STATUS_PATH_UNSAFE' }
    $statusPath=[IO.Path]::GetFullPath($rawStatus)
    if (-not [string]::Equals([IO.Path]::GetDirectoryName($statusPath),$dir,[StringComparison]::OrdinalIgnoreCase)) {
      throw 'NATIVE_AGENT_TASK_GUARDIAN_STATUS_DIRECTORY_UNCONFIRMED'
    }
    if ([IO.Path]::GetFileName($statusPath) -cnotmatch '^agent-job-[0-9a-f]{32}\.status$') {
      throw 'NATIVE_AGENT_TASK_GUARDIAN_STATUS_NAME_UNCONFIRMED'
    }
    $guardianStatuses+=,[pscustomobject]@{process=$g;status=$statusPath}
  }
  $nodesByPid=@{}
  foreach ($node in $nodes) {
    if (-not $node.ExecutablePath -or -not $node.CommandLine -or $null -eq $node.CreationDate) { throw 'NATIVE_AGENT_TASK_NODE_IDENTITY_UNKNOWN' }
    $nodesByPid[[string]$node.ProcessId]=$node
  }
  $liveRoots=0
  $liveGuardians=0
  $rootPid=$null
  $records=@()
  $ownedRootPids=@{}
  foreach ($marker in $markers) {
    if ($marker.Name -cnotmatch '^agent-job-[0-9a-f]{32}\.status$') { throw 'NATIVE_AGENT_TASK_RECEIPT_NAME_INVALID' }
    if (($marker.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'NATIVE_AGENT_TASK_RECEIPT_REPARSE_UNSAFE' }
    if ($marker.Length -gt 128) { throw 'NATIVE_AGENT_TASK_RECEIPT_OVERSIZED' }
    $data=''
    for ($attempt=0; $attempt -lt 4; $attempt++) {
      $data=[IO.File]::ReadAllText($marker.FullName).Trim()
      if ($data -cmatch '^NWJOB3 ([1-9][0-9]*) ([1-9][0-9]*)$') { break }
      Start-Sleep -Milliseconds 60
    }
    if ($data -cnotmatch '^NWJOB3 ([1-9][0-9]*) ([1-9][0-9]*)$') { throw 'NATIVE_AGENT_TASK_RECEIPT_INVALID' }
    $ownedPid=[long]$Matches[1]
    $created=[string]$Matches[2]
    if ($ownedPid -gt 4294967295) { throw 'NATIVE_AGENT_TASK_RECEIPT_PID_INVALID' }
    $matchedGuardians=@($guardianStatuses | Where-Object {
      [string]::Equals($_.status,$marker.FullName,[StringComparison]::OrdinalIgnoreCase)
    })
    if ($matchedGuardians.Count -gt 1) { throw 'NATIVE_AGENT_TASK_GUARDIAN_AMBIGUOUS' }
    $liveGuardians+=$matchedGuardians.Count
    $root=$nodesByPid[[string]$ownedPid]
    $matchedRoot=$false
    if ($null -ne $root) {
      $actual=$root.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()
      $matchedRoot=($actual -ceq $created)
      if ($matchedRoot) {
        if (-not [IO.Path]::IsPathRooted([string]$root.ExecutablePath)) { throw 'NATIVE_AGENT_TASK_ROOT_BINARY_PATH_UNSAFE' }
        if (-not [string]::Equals([IO.Path]::GetFullPath([string]$root.ExecutablePath),$expectedNode,[StringComparison]::OrdinalIgnoreCase)) {
          throw 'NATIVE_AGENT_TASK_ROOT_BINARY_MISMATCH'
        }
      }
    }
    if ($matchedRoot) {
      $liveRoots++
      $rootPid=$ownedPid
      $ownedRootPids[[string]$ownedPid]=$true
      # Without an owning guardian the Node child may be an orphan. Never compact.
      if ($matchedGuardians.Count -ne 1) { throw 'NATIVE_AGENT_TASK_ORPHAN_ROOT_UNCONFIRMED' }
    }
    $records+=,[pscustomobject]@{
      file=$marker.FullName
      data=$data
      written=$marker.LastWriteTimeUtc
      created=$marker.CreationTimeUtc
      liveRoot=$matchedRoot
      guardianCount=$matchedGuardians.Count
    }
  }
  # A native guardian from THIS Agent's protected receipt directory whose
  # marker is missing/renamed is indeterminate, never an empty healthy owner.
  foreach ($g in $guardianStatuses) {
    $found=$false
    foreach ($record in $records) {
      if ([string]::Equals($g.status,$record.file,[StringComparison]::OrdinalIgnoreCase)) {
        $found=$true
        break
      }
    }
    if (-not $found) { throw 'NATIVE_AGENT_TASK_GUARDIAN_RECEIPT_MISSING' }
  }
  # Parse Node command-line tokens rather than matching a raw CLI path substring.
  # The installed launcher can contain Node flags before the CLI; 8.3 short/long
  # paths and quoted "agent" "run" arguments must not hide an orphan Agent.
  $expectedCli=[IO.Path]::GetFullPath($expectedCli)
  $expectedCliName=[IO.Path]::GetFileName($expectedCli)
  $unknownAgentNodes=0
  foreach ($node in $nodes) {
    if (-not [IO.Path]::IsPathRooted([string]$node.ExecutablePath)) { throw 'NATIVE_AGENT_TASK_NODE_BINARY_PATH_UNSAFE' }
    if (-not [string]::Equals([IO.Path]::GetFullPath([string]$node.ExecutablePath),$expectedNode,[StringComparison]::OrdinalIgnoreCase)) { continue }
    if ($ownedRootPids.ContainsKey([string]$node.ProcessId)) { continue }
    $tokens=@([regex]::Matches([string]$node.CommandLine,'"(?:[^"]+)"|[^\s"]+') | ForEach-Object { $_.Value.Trim('"') })
    $matchedAgentCli=$false
    for ($i=1; $i -lt ($tokens.Count-2); $i++) {
      $candidate=[string]$tokens[$i]
      if (-not [IO.Path]::IsPathRooted($candidate)) { continue }
      $canonicalCandidate=[IO.Path]::GetFullPath($candidate)
      if ([string]::Equals($canonicalCandidate,$expectedCli,[StringComparison]::OrdinalIgnoreCase) -and
          $tokens[$i+1] -ceq 'agent' -and $tokens[$i+2] -ceq 'run') {
        $matchedAgentCli=$true
        break
      }
    }
    if ($matchedAgentCli) {
      $unknownAgentNodes++
    } elseif ($node.CommandLine.IndexOf($expectedCliName,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
              $node.CommandLine -match '\bagent"?\s+"?run\b') {
      # Ambiguous same-name CLI with Agent verbs is not a safe "no owner" proof.
      throw 'NATIVE_AGENT_TASK_NODE_CLI_IDENTITY_UNCONFIRMED'
    }
  }
  if ($unknownAgentNodes -gt 0) { throw 'NATIVE_AGENT_TASK_UNOWNED_AGENT_NODE_UNCONFIRMED' }
  # Never compact during a running/queued task or while a pinned Job root/guardian
  # remains. Keep 16 recent dead receipts for forensic review, plus any younger
  # than 30 seconds to exclude concurrent guardian startup/marker creation races.
  # The deletion uses the SAME exclusive Windows file HANDLE that verified
  # bytes, creation FILETIME, last-write FILETIME, size and reparse attributes.
  # SetFileInformationByHandle(FileDispositionInfo) avoids path-based check/delete TOCTOU.
  $state=([string]$task.State).ToLowerInvariant()
  if (($state -eq 'ready' -or $state -eq 'disabled') -and $liveRoots -eq 0 -and $liveGuardians -eq 0) {
    $safe=@($records | Where-Object { -not $_.liveRoot -and $_.guardianCount -eq 0 } |
      Sort-Object -Property written -Descending)
    $now=[DateTime]::UtcNow
    $aged=@($safe | Select-Object -Skip 16 | Where-Object { ($now-$_.written).TotalSeconds -ge 30 })
    if ($aged.Count -gt 0) {
      # Compile the interop only when old receipts actually need compaction.
      # No native DLL, unchecked child process or external filesystem tool.
      Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class NexowireAgentJobReceiptDelete {
  [StructLayout(LayoutKind.Sequential)]
  public struct FILETIME { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential)]
  public struct FILE_INFO {
    public uint Attributes;
    public FILETIME Created;
    public FILETIME Accessed;
    public FILETIME Written;
    public uint Volume;
    public uint SizeHigh;
    public uint SizeLow;
    public uint Links;
    public uint IndexHigh;
    public uint IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct DISPOSITION { [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile; }
  [DllImport("kernel32.dll", EntryPoint="CreateFileW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern SafeFileHandle Open(string path, uint access, uint sharing,
    IntPtr security, uint creation, uint options, IntPtr templateFile);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FILE_INFO info);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind,
    ref DISPOSITION value, uint size);
  private static ulong Ticks(FILETIME time) { return ((ulong)time.High<<32)|time.Low; }

  public static void DeleteVerified(string path, string content,
    long writtenFiletime, long createdFiletime) {
    // GENERIC_READ | DELETE; FILE_SHARE_NONE; OPEN_EXISTING;
    // FILE_FLAG_OPEN_REPARSE_POINT. Untrusted replacement cannot happen
    // while this exact handle is held.
    using (var handle=Open(path,0x80010000u,0u,IntPtr.Zero,3u,0x00200000u,IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(),"NATIVE_AGENT_TASK_RECEIPT_OPEN_UNCONFIRMED");
      FILE_INFO info;
      if (!GetFileInformationByHandle(handle,out info))
        throw new Win32Exception(Marshal.GetLastWin32Error(),"NATIVE_AGENT_TASK_RECEIPT_IDENTITY_UNKNOWN");
      if ((info.Attributes & 0x400u)!=0 || info.SizeHigh!=0 || info.SizeLow>128u ||
          Ticks(info.Created)!=(ulong)createdFiletime ||
          Ticks(info.Written)!=(ulong)writtenFiletime)
        throw new IOException("NATIVE_AGENT_TASK_RECEIPT_RACE_UNCONFIRMED");
      using (var stream=new FileStream(handle,FileAccess.Read,4096,false)) {
        using (var reader=new StreamReader(stream,Encoding.UTF8,true,4096,true)) {
          if (!String.Equals(reader.ReadToEnd().Trim(),content,StringComparison.Ordinal))
            throw new IOException("NATIVE_AGENT_TASK_RECEIPT_RACE_UNCONFIRMED");
        }
        DISPOSITION disposition=new DISPOSITION {DeleteFile=true};
        if (!SetFileInformationByHandle(handle,4,ref disposition,
              (uint)Marshal.SizeOf(typeof(DISPOSITION))))
          throw new Win32Exception(Marshal.GetLastWin32Error(),"NATIVE_AGENT_TASK_RECEIPT_DELETE_UNCONFIRMED");
      }
    }
  }
}
'@
      foreach ($candidate in $aged) {
        [NexowireAgentJobReceiptDelete]::DeleteVerified(
          $candidate.file,$candidate.data,
          $candidate.written.ToFileTimeUtc(),$candidate.created.ToFileTimeUtc()
        )
      }
    }
  }
  $remaining=@(Get-ChildItem -LiteralPath $dir -Filter 'agent-job-*.status' -File -ErrorAction Stop)
  [pscustomobject]@{
    installed=$true
    state=$state
    guarded=$guarded
    receipts=$remaining.Count
    liveRoots=$liveRoots
    liveGuardians=$liveGuardians
    rootPid=$rootPid
    unknownAgentNodes=$unknownAgentNodes
  } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $lock) { $lock.Dispose() }
}
`;

async function windowsAgentTaskOwnerReadback(
  options: NativeAgentLifecycleOptions,
): Promise<WindowsAgentTaskOwnerReadback> {
  return await runPowerShellJson<WindowsAgentTaskOwnerReadback>(
    WINDOWS_AGENT_TASK_OWNER_READBACK_SCRIPT,
    windowsEnv(options),
  );
}

export function nativeAgentTaskStopConfirmed(state: WindowsAgentTaskOwnerReadback): boolean {
  return state.guarded && state.receipts > 0 &&
    (state.state === 'ready' || state.state === 'disabled') &&
    state.liveRoots === 0 && state.liveGuardians === 0 &&
    state.unknownAgentNodes === 0;
}

export function nativeAgentTaskStartConfirmed(state: WindowsAgentTaskOwnerReadback): boolean {
  return state.guarded && state.state === 'running' &&
    state.liveRoots === 1 && state.liveGuardians === 1 &&
    state.rootPid !== null && state.rootPid > 0 &&
    state.unknownAgentNodes === 0;
}

async function controlWindows(
  action: 'start' | 'stop' | 'restart',
  options: NativeAgentLifecycleOptions,
): Promise<NativeAgentLifecycleStatus> {
  const before = await windowsAgentTaskOwnerReadback(options);
  if (!before.installed || !before.guarded) {
    throw new Error('NATIVE_AGENT_TASK_JOB_GUARD_REQUIRED');
  }
  if (action !== 'stop' &&
      (before.liveRoots > 0 || before.liveGuardians > 0) &&
      before.state !== 'running') {
    throw new Error('NATIVE_AGENT_TASK_PREEXISTING_OWNER_UNCONFIRMED');
  }
  if (action === 'start' && before.state === 'running') {
    if (!nativeAgentTaskStartConfirmed(before)) {
      throw new Error('NATIVE_AGENT_TASK_RUNNING_OWNER_UNCONFIRMED');
    }
    return {...await windowsStatus(options), pid: before.rootPid};
  }

  if (action !== 'start') {
    await runPowerShellJson<{ok:boolean}>(
      [
        "$ErrorActionPreference='Stop'",
        '$name=$env:NEXOWIRE_AGENT_TASK_NAME',
        '$task=Get-ScheduledTask -TaskName $name -ErrorAction Stop',
        "if ($task.State -eq 'Running' -or $task.State -eq 'Queued') { Stop-ScheduledTask -TaskName $name -ErrorAction Stop }",
        '[pscustomobject]@{ok=$true} | ConvertTo-Json -Compress',
      ].join('\n'),
      windowsEnv(options),
    );
    let stopped = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const state = await windowsAgentTaskOwnerReadback(options);
      // A just-stopped PowerShell can leave the Job guardian active for
      // milliseconds; do not start a second Agent until BOTH have exited.
      if (nativeAgentTaskStopConfirmed(state)) {
        stopped = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    if (!stopped) {
      throw new Error('NATIVE_AGENT_TASK_DESCENDANT_STOP_UNCONFIRMED');
    }
    if (action === 'stop') return await windowsStatus(options);
  }

  await runPowerShellJson<{ok:boolean}>(
    [
      "$ErrorActionPreference='Stop'",
      '$name=$env:NEXOWIRE_AGENT_TASK_NAME',
      'Start-ScheduledTask -TaskName $name -ErrorAction Stop',
      '[pscustomobject]@{ok=$true} | ConvertTo-Json -Compress',
    ].join('\n'),
    windowsEnv(options),
  );
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await windowsAgentTaskOwnerReadback(options);
    if (nativeAgentTaskStartConfirmed(state)) {
      return {...await windowsStatus(options), pid: state.rootPid};
    }
    if (state.liveRoots > 1 || state.liveGuardians > 1) {
      throw new Error('NATIVE_AGENT_TASK_MULTIPLE_OWNERS_UNCONFIRMED');
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('NATIVE_AGENT_TASK_START_READBACK_UNCONFIRMED');
}

async function uninstallWindows(
  options: NativeAgentLifecycleOptions,
): Promise<{ removed: boolean; name: string }> {
  const current = await windowsAgentTaskOwnerReadback(options);
  if (current.installed) {
    // Never unregister or delete the launcher while its Job descendants are unproven.
    await controlWindows('stop', options);
  } else {
    // A removed/absent task may still leave a live orphan and stale receipts.
    await assertNoResidualWindowsTaskOwnerArtifacts(lifecycleRoot(options));
  }
  const result = await runPowerShellJson<{ removed: boolean }>(
    [
      "$ErrorActionPreference='Stop'",
      '$name=$env:NEXOWIRE_AGENT_TASK_NAME',
      '$task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue',
      'if ($null -ne $task) {',
      '  Unregister-ScheduledTask -TaskName $name -Confirm:$false',
      '  [pscustomobject]@{removed=$true} | ConvertTo-Json -Compress',
      '} else {',
      '  [pscustomobject]@{removed=$false} | ConvertTo-Json -Compress',
      '}',
    ].join('\n'),
    windowsEnv(options),
  );
  await fs.rm(lifecycleRoot(options), {
    recursive: true,
    force: true,
  });
  return {
    removed: result.removed,
    name: windowsTaskName(options),
  };
}

async function linuxStatus(
  options: NativeAgentLifecycleOptions,
): Promise<NativeAgentLifecycleStatus> {
  const definition = linuxUnitPath(options);
  let installed = false;
  try {
    await fs.access(definition);
    installed = true;
  } catch {
    // Not installed.
  }

  if (!installed) {
    return StatusSchema.parse({
      installed: false,
      platform: 'linux',
      name: linuxUnitName(options),
      state: 'not-installed',
      autostart: false,
      pid: null,
      launcher: launcherPath(options, 'linux'),
      definition,
    });
  }

  const result = await runCommand(
    'systemctl',
    [
      '--user',
      'show',
      linuxUnitName(options),
      '--property=ActiveState',
      '--property=SubState',
      '--property=UnitFileState',
      '--property=MainPID',
      '--no-pager',
    ],
    options.env ?? process.env,
    true,
  );
  const values = new Map<string, string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0) {
      values.set(line.slice(0, index), line.slice(index + 1));
    }
  }
  const pid = Number(values.get('MainPID') ?? '0');
  return StatusSchema.parse({
    installed: true,
    platform: 'linux',
    name: linuxUnitName(options),
    state:
      result.code === 0
        ? (values.get('ActiveState') ?? 'unknown') +
          '/' +
          (values.get('SubState') ?? 'unknown')
        : 'unknown',
    autostart:
      values.get('UnitFileState') === 'enabled' ||
      values.get('UnitFileState') === 'enabled-runtime',
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    launcher: launcherPath(options, 'linux'),
    definition,
  });
}

async function installLinux(
  options: NativeAgentLifecycleOptions,
): Promise<NativeAgentLifecycleStatus> {
  const launcher = launcherPath(options, 'linux');
  const unitFile = linuxUnitPath(options);
  await fs.mkdir(path.dirname(launcher), {
    recursive: true,
    mode: 0o700,
  });
  await fs.mkdir(path.dirname(unitFile), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(
    launcher,
    buildNativeAgentLauncher({
      ...options,
      platform: 'linux',
    }),
    { encoding: 'utf8', mode: 0o700 },
  );
  await fs.chmod(launcher, 0o700);
  await fs.writeFile(
    unitFile,
    buildLinuxUserUnit(options),
    { encoding: 'utf8', mode: 0o600 },
  );
  await runCommand(
    'systemctl',
    ['--user', 'daemon-reload'],
    options.env ?? process.env,
  );
  await runCommand(
    'systemctl',
    ['--user', 'enable', '--now', linuxUnitName(options)],
    options.env ?? process.env,
  );
  await writeManifest(options, 'linux');
  return await linuxStatus(options);
}

async function controlLinux(
  action: 'start' | 'stop' | 'restart',
  options: NativeAgentLifecycleOptions,
): Promise<NativeAgentLifecycleStatus> {
  await runCommand(
    'systemctl',
    ['--user', action, linuxUnitName(options)],
    options.env ?? process.env,
  );
  return await linuxStatus(options);
}

async function uninstallLinux(
  options: NativeAgentLifecycleOptions,
): Promise<{ removed: boolean; name: string }> {
  const installed = (
    await linuxStatus(options)
  ).installed;
  if (installed) {
    await runCommand(
      'systemctl',
      ['--user', 'disable', '--now', linuxUnitName(options)],
      options.env ?? process.env,
      true,
    );
  }
  await fs.rm(linuxUnitPath(options), { force: true });
  await runCommand(
    'systemctl',
    ['--user', 'daemon-reload'],
    options.env ?? process.env,
    true,
  );
  await fs.rm(lifecycleRoot(options), {
    recursive: true,
    force: true,
  });
  return {
    removed: installed,
    name: linuxUnitName(options),
  };
}


function launchdDomain(
  options: NativeAgentLifecycleOptions,
): string {
  const uid =
    options.uid ??
    (typeof process.getuid === 'function'
      ? process.getuid()
      : undefined);
  if (uid === undefined) {
    throw new Error(
      'Cannot determine current user ID for launchd lifecycle.',
    );
  }
  return 'gui/' + uid;
}

async function macStatus(
  options: NativeAgentLifecycleOptions,
): Promise<NativeAgentLifecycleStatus> {
  const definition = macPlistPath(options);
  let installed = false;
  try {
    await fs.access(definition);
    installed = true;
  } catch {
    // Not installed.
  }

  if (!installed) {
    return StatusSchema.parse({
      installed: false,
      platform: 'darwin',
      name: macLabel(options),
      state: 'not-installed',
      autostart: false,
      pid: null,
      launcher: launcherPath(options, 'darwin'),
      definition,
    });
  }

  const target = launchdDomain(options) + '/' + macLabel(options);
  const result = await runCommand(
    'launchctl',
    ['print', target],
    options.env ?? process.env,
    true,
  );
  const pidMatch = /\bpid\s*=\s*(\d+)/.exec(result.stdout);
  const pid = pidMatch ? Number(pidMatch[1]) : null;

  return StatusSchema.parse({
    installed: true,
    platform: 'darwin',
    name: macLabel(options),
    state:
      result.code === 0
        ? pid && pid > 0
          ? 'running'
          : 'loaded'
        : 'stopped',
    autostart: true,
    pid: pid && pid > 0 ? pid : null,
    launcher: launcherPath(options, 'darwin'),
    definition,
  });
}

async function installMac(
  options: NativeAgentLifecycleOptions,
): Promise<NativeAgentLifecycleStatus> {
  const launcher = launcherPath(options, 'darwin');
  const plist = macPlistPath(options);

  await fs.mkdir(path.dirname(launcher), {
    recursive: true,
    mode: 0o700,
  });
  await fs.mkdir(path.dirname(plist), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(
    launcher,
    buildNativeAgentLauncher({
      ...options,
      platform: 'darwin',
    }),
    { encoding: 'utf8', mode: 0o700 },
  );
  await fs.chmod(launcher, 0o700);
  await fs.writeFile(
    plist,
    buildMacLaunchAgentPlist(options),
    { encoding: 'utf8', mode: 0o600 },
  );

  const domain = launchdDomain(options);
  await runCommand(
    'launchctl',
    ['bootout', domain + '/' + macLabel(options)],
    options.env ?? process.env,
    true,
  );
  await runCommand(
    'launchctl',
    ['bootstrap', domain, plist],
    options.env ?? process.env,
  );

  await writeManifest(options, 'darwin');
  await new Promise((resolve) => setTimeout(resolve, 250));
  return await macStatus(options);
}

async function controlMac(
  action: 'start' | 'stop' | 'restart',
  options: NativeAgentLifecycleOptions,
): Promise<NativeAgentLifecycleStatus> {
  const domain = launchdDomain(options);
  const target = domain + '/' + macLabel(options);
  const plist = macPlistPath(options);

  if (action === 'stop') {
    await runCommand(
      'launchctl',
      ['bootout', target],
      options.env ?? process.env,
      true,
    );
  } else if (action === 'start') {
    await runCommand(
      'launchctl',
      ['bootstrap', domain, plist],
      options.env ?? process.env,
    );
  } else {
    await runCommand(
      'launchctl',
      ['bootout', target],
      options.env ?? process.env,
      true,
    );
    await runCommand(
      'launchctl',
      ['bootstrap', domain, plist],
      options.env ?? process.env,
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 250));
  return await macStatus(options);
}

async function uninstallMac(
  options: NativeAgentLifecycleOptions,
): Promise<{ removed: boolean; name: string }> {
  const status = await macStatus(options);
  if (status.installed) {
    await runCommand(
      'launchctl',
      ['bootout', launchdDomain(options) + '/' + macLabel(options)],
      options.env ?? process.env,
      true,
    );
  }
  await fs.rm(macPlistPath(options), { force: true });
  await fs.rm(lifecycleRoot(options), {
    recursive: true,
    force: true,
  });
  return {
    removed: status.installed,
    name: macLabel(options),
  };
}

async function writeManifest(
  options: NativeAgentLifecycleOptions,
  platform: 'win32' | 'linux' | 'darwin',
): Promise<void> {
  const env = persistedNativeAgentEnvironment(
    options.env ?? process.env,
  );
  await fs.mkdir(lifecycleRoot(options), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(
    manifestPath(options),
    JSON.stringify(
      {
        version: 1,
        platform,
        installedAt: new Date().toISOString(),
        persistedEnvNames: Object.keys(env).sort(),
      },
      null,
      2,
    ) + '\n',
    { encoding: 'utf8', mode: 0o600 },
  );
}

export async function nativeAgentLifecycleStatus(
  options: NativeAgentLifecycleOptions = {},
): Promise<NativeAgentLifecycleStatus> {
  const platform = platformOf(options);
  if (platform === 'win32') return await windowsStatus(options);
  if (platform === 'linux') return await linuxStatus(options);
  return await macStatus(options);
}

/**
 * When an owner deliberately configures physical CORE on Windows, never
 * silently install a direct-mode Agent that cannot even attach its already
 * installed elevated Broker. A ready, independently authenticated Broker can
 * supply the default broker *mode*, not a CORE grant or physical consent.
 * No local/remote tool payload or untrusted environment can supply approval.
 */
export async function prepareWindowsCoreAgentInstallEnvironment(
  env: NodeJS.ProcessEnv,
  brokerHealth: () => Promise<{ready:boolean;status:string}> = async()=>{
    const {probePrivilegedBrokerHealth}=await import('./privileged-broker-lifecycle.js');
    return probePrivilegedBrokerHealth({env});
  },
): Promise<NodeJS.ProcessEnv> {
  if(!env.NEXOWIRE_CORE_AUTHORITY_URL?.trim())return env;
  const requested=env.NEXOWIRE_PRIVILEGE_MODE?.trim().toLowerCase();
  if(requested==='direct')throw new Error('CORE_BROKER_MODE_REQUIRED');
  if(requested && requested!=='broker')throw new Error('CORE_BROKER_MODE_INVALID');
  const report=await brokerHealth();
  if(report.ready!==true)throw new Error('CORE_BROKER_NOT_READY_'+
    report.status.replace(/[^A-Z_]/g,'').slice(0,40));
  return requested==='broker'?env:{...env,NEXOWIRE_PRIVILEGE_MODE:'broker'};
}

export async function installNativeAgentLifecycle(
  options: NativeAgentLifecycleOptions = {},
): Promise<NativeAgentLifecycleStatus> {
  persistedNativeAgentEnvironment(options.env ?? process.env);
  const platform = platformOf(options);
  if (platform === 'win32') {
    const prepared=await prepareWindowsCoreAgentInstallEnvironment(options.env ?? process.env);
    return await installWindows({...options,env:prepared});
  }
  if (platform === 'linux') return await installLinux(options);
  return await installMac(options);
}

export async function startNativeAgentLifecycle(
  options: NativeAgentLifecycleOptions = {},
): Promise<NativeAgentLifecycleStatus> {
  const platform = platformOf(options);
  if (platform === 'win32') return await controlWindows('start', options);
  if (platform === 'linux') return await controlLinux('start', options);
  return await controlMac('start', options);
}

export async function stopNativeAgentLifecycle(
  options: NativeAgentLifecycleOptions = {},
): Promise<NativeAgentLifecycleStatus> {
  const platform = platformOf(options);
  if (platform === 'win32') return await controlWindows('stop', options);
  if (platform === 'linux') return await controlLinux('stop', options);
  return await controlMac('stop', options);
}

export async function restartNativeAgentLifecycle(
  options: NativeAgentLifecycleOptions = {},
): Promise<NativeAgentLifecycleStatus> {
  const platform = platformOf(options);
  if (platform === 'win32') return await controlWindows('restart', options);
  if (platform === 'linux') return await controlLinux('restart', options);
  return await controlMac('restart', options);
}

export async function uninstallNativeAgentLifecycle(
  options: NativeAgentLifecycleOptions = {},
): Promise<{ removed: boolean; name: string }> {
  const platform = platformOf(options);
  if (platform === 'win32') return await uninstallWindows(options);
  if (platform === 'linux') return await uninstallLinux(options);
  return await uninstallMac(options);
}

export async function runNativeAgentLifecycleCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const command = args[0] ?? 'status';
  const options: NativeAgentLifecycleOptions = { env };
  let result: unknown;

  switch (command) {
    case 'install':
      result = await installNativeAgentLifecycle(options);
      break;
    case 'status':
      result = await nativeAgentLifecycleStatus(options);
      break;
    case 'start':
      result = await startNativeAgentLifecycle(options);
      break;
    case 'stop':
      result = await stopNativeAgentLifecycle(options);
      break;
    case 'restart':
      result = await restartNativeAgentLifecycle(options);
      break;
    case 'uninstall':
      result = await uninstallNativeAgentLifecycle(options);
      break;
    default:
      throw new Error(
        'Usage: nexowire agent [run|install|status|start|stop|restart|uninstall]',
      );
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
