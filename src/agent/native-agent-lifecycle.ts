import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as z from 'zod';

const WINDOWS_TASK_DEFAULT = 'Nexowire Native Agent';
const LINUX_UNIT_DEFAULT = 'nexowire-agent.service';

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
  platform: z.enum(['win32', 'linux']),
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
}

function platformOf(
  options: NativeAgentLifecycleOptions,
): 'win32' | 'linux' {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32' || platform === 'linux') return platform;
  throw new Error(
    'Native-agent install/autostart lifecycle currently supports Windows and Linux.',
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
  platform: 'win32' | 'linux',
): string {
  return path.join(
    lifecycleRoot(options),
    platform === 'win32' ? 'launch.ps1' : 'launch.sh',
  );
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
  return path.join(
    options.homeDir ?? os.homedir(),
    '.config',
    'systemd',
    'user',
    linuxUnitName(options),
  );
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

async function runCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  allowFailure = false,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      windowsHide: true,
      env: { ...process.env, ...env },
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
    env,
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
    "$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument",
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

async function writeManifest(
  options: NativeAgentLifecycleOptions,
  platform: 'win32' | 'linux',
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
  return platformOf(options) === 'win32'
    ? await windowsStatus(options)
    : await linuxStatus(options);
}

export async function installNativeAgentLifecycle(
  options: NativeAgentLifecycleOptions = {},
): Promise<NativeAgentLifecycleStatus> {
  persistedNativeAgentEnvironment(options.env ?? process.env);
  return platformOf(options) === 'win32'
    ? await installWindows(options)
    : await installLinux(options);
}

export async function startNativeAgentLifecycle(
  options: NativeAgentLifecycleOptions = {},
): Promise<NativeAgentLifecycleStatus> {
  return platformOf(options) === 'win32'
    ? await controlWindows('start', options)
    : await controlLinux('start', options);
}

export async function stopNativeAgentLifecycle(
  options: NativeAgentLifecycleOptions = {},
): Promise<NativeAgentLifecycleStatus> {
  return platformOf(options) === 'win32'
    ? await controlWindows('stop', options)
    : await controlLinux('stop', options);
}

export async function restartNativeAgentLifecycle(
  options: NativeAgentLifecycleOptions = {},
): Promise<NativeAgentLifecycleStatus> {
  return platformOf(options) === 'win32'
    ? await controlWindows('restart', options)
    : await controlLinux('restart', options);
}

export async function uninstallNativeAgentLifecycle(
  options: NativeAgentLifecycleOptions = {},
): Promise<{ removed: boolean; name: string }> {
  return platformOf(options) === 'win32'
    ? await uninstallWindows(options)
    : await uninstallLinux(options);
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
