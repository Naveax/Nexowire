import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as z from 'zod';

const WINDOWS_TASK_DEFAULT = 'Nexowire Native Agent';
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
  };
}

const LINUX_UNIT_DEFAULT = 'nexowire-agent.service';
const MAC_LABEL_DEFAULT = 'com.nexowire.agent';

const PERSISTED_ENV_NAMES = [
  'NEXOWIRE_HUB_WS_URL',
  'NEXOWIRE_HUB_WS_URLS',
  'NEXOWIRE_DEVICE_NAME',
  'NEXOWIRE_ALLOWED_ROOTS',
  'NEXOWIRE_STATE_DIR',
  'NEXOWIRE_PROCESS_STATE_FILE',
  'NEXOWIRE_PROCESS_WORKER_ROOT',
  'NEXOWIRE_TASK_GRAPH_STATE_FILE',
  'NEXOWIRE_RUNBOOK_STATE_FILE',
  'NEXOWIRE_AGENT_HEARTBEAT_MS',
  'NEXOWIRE_AGENT_TOKEN_FILE',
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
    lines.push(
      '& ' +
        psLiteral(rt.executable) +
        ' ' +
        rt.args.map(psLiteral).join(' '),
      'exit $LASTEXITCODE',
      '',
    );
    return lines.join('\r\n');
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

async function installWindows(
  options: NativeAgentLifecycleOptions,
): Promise<NativeAgentLifecycleStatus> {
  const root = lifecycleRoot(options);
  const launcher = launcherPath(options, 'win32');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    launcher,
    buildNativeAgentLauncher({
      ...options,
      platform: 'win32',
    }),
    { encoding: 'utf8', mode: 0o600 },
  );

  const script = [
    "$ErrorActionPreference='Stop'",
    '$name=$env:NEXOWIRE_AGENT_TASK_NAME',
    '$launcher=$env:NEXOWIRE_AGENT_LAUNCHER',
    '$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name',
    '$argument=\'-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "\' + $launcher.Replace(\'"\',\'""\') + \'"\'',
    "$action=New-ScheduledTaskAction -Execute 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -Argument $argument",
    '$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user',
    '$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited',
    '$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew',
    "Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Nexowire first-party native agent' -Force | Out-Null",
    'Start-ScheduledTask -TaskName $name',
    '[pscustomobject]@{ok=$true} | ConvertTo-Json -Compress',
  ].join('\n');

  await runPowerShellJson<{ ok: boolean }>(
    script,
    windowsEnv(options),
  );
  await writeManifest(options, 'win32');
  await new Promise((resolve) => setTimeout(resolve, 250));
  return await windowsStatus(options);
}

async function controlWindows(
  action: 'start' | 'stop' | 'restart',
  options: NativeAgentLifecycleOptions,
): Promise<NativeAgentLifecycleStatus> {
  const commands =
    action === 'restart'
      ? [
          'Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue',
          'Start-ScheduledTask -TaskName $name',
        ]
      : action === 'start'
        ? ['Start-ScheduledTask -TaskName $name']
        : [
            'Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue',
          ];
  await runPowerShellJson<{ ok: boolean }>(
    [
      "$ErrorActionPreference='Stop'",
      '$name=$env:NEXOWIRE_AGENT_TASK_NAME',
      ...commands,
      '[pscustomobject]@{ok=$true} | ConvertTo-Json -Compress',
    ].join('\n'),
    windowsEnv(options),
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  return await windowsStatus(options);
}

async function uninstallWindows(
  options: NativeAgentLifecycleOptions,
): Promise<{ removed: boolean; name: string }> {
  const result = await runPowerShellJson<{ removed: boolean }>(
    [
      "$ErrorActionPreference='Stop'",
      '$name=$env:NEXOWIRE_AGENT_TASK_NAME',
      '$task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue',
      'if ($null -ne $task) {',
      '  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue',
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

export async function installNativeAgentLifecycle(
  options: NativeAgentLifecycleOptions = {},
): Promise<NativeAgentLifecycleStatus> {
  persistedNativeAgentEnvironment(options.env ?? process.env);
  const platform = platformOf(options);
  if (platform === 'win32') return await installWindows(options);
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
