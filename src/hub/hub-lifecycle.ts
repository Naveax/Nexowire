import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod';

const WINDOWS_TASK_DEFAULT = 'Nexowire Hub';

const SAFE_ENV_NAMES = [
  'NEXOWIRE_STATE_DIR',
  'NEXOWIRE_HTTP_HOST',
  'NEXOWIRE_HTTP_PORT',
  'NEXOWIRE_HTTP_ALLOWED_HOSTS',
  'NEXOWIRE_SKILLS_DIR',
  'NEXOWIRE_CONTROL_PLANE_URL',
  'NEXOWIRE_CONTROL_PLANE_AUTH_TIMEOUT_MS',
  'NEXOWIRE_MCP_RESOURCE_URL',
  'NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_FILE',
  'NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_DPAPI_FILE',
  'NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_PLATFORM_NAME',
] as const;

const FORBIDDEN_SECRET_ENV = [
  'NEXOWIRE_MCP_BEARER_TOKEN',
  'NEXOWIRE_MCP_BEARER_TOKENS',
  'NEXOWIRE_AGENT_TOKEN',
  'NEXOWIRE_AGENT_TOKENS',
  'NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN',
] as const;

const StatusSchema = z.object({
  installed: z.boolean(),
  platform: z.literal('win32'),
  name: z.string(),
  state: z.string(),
  autostart: z.boolean(),
  launcher: z.string(),
  definition: z.string(),
});

export type HubLifecycleStatus = z.infer<typeof StatusSchema>;

export function shouldRestartHubAfterInstall(input: {
  wasRunning: boolean;
  previousLauncher: string | null;
  nextLauncher: string;
}): boolean {
  return (
    input.wasRunning &&
    input.previousLauncher !== input.nextLauncher
  );
}

export interface HubInstallPlan {
  registerTask: boolean;
  restartTask: boolean;
  startTask: boolean;
}

export function planHubInstall(input: {
  installed: boolean;
  state: string;
  previousLauncher: string | null;
  nextLauncher: string;
}): HubInstallPlan {
  if (!input.installed) {
    return {
      registerTask: true,
      restartTask: false,
      startTask: true,
    };
  }

  const running = input.state === 'running';
  return {
    registerTask: false,
    restartTask:
      running &&
      input.previousLauncher !== input.nextLauncher,
    startTask: !running,
  };
}

export interface HubLifecycleOptions {
  env?: NodeJS.ProcessEnv;
  cliEntrypoint?: string;
  execPath?: string;
  execArgv?: readonly string[];
  rootDir?: string;
  homeDir?: string;
  windowsTaskName?: string;
}

function trim(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new Error(
      'Nexowire Hub lifecycle is currently implemented for Windows only.',
    );
  }
}

function rootDir(options: HubLifecycleOptions): string {
  return (
    options.rootDir ??
    path.join(options.homeDir ?? os.homedir(), '.nexowire', 'hub-service')
  );
}

function launcherPath(options: HubLifecycleOptions): string {
  return path.join(rootDir(options), 'launch.ps1');
}

function manifestPath(options: HubLifecycleOptions): string {
  return path.join(rootDir(options), 'lifecycle.json');
}

function taskName(options: HubLifecycleOptions): string {
  const value =
    options.windowsTaskName ??
    options.env?.NEXOWIRE_HUB_TASK_NAME ??
    WINDOWS_TASK_DEFAULT;
  const name = value.trim();
  if (!name || name.length > 128) {
    throw new Error('Hub Scheduled Task name must be 1-128 characters.');
  }
  return name;
}

export function persistedHubEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  for (const name of FORBIDDEN_SECRET_ENV) {
    if (trim(env[name])) {
      throw new Error(
        'Hub lifecycle refuses to persist plaintext secret variable ' +
          name +
          '. Use hash-only stored credentials or a protected secret source.',
      );
    }
  }

  const result: Record<string, string> = {};
  for (const name of SAFE_ENV_NAMES) {
    const value = trim(env[name]);
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function psLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function runtime(options: HubLifecycleOptions): {
  executable: string;
  args: string[];
} {
  const cliEntrypoint = options.cliEntrypoint ?? process.argv[1];
  if (!cliEntrypoint) {
    throw new Error('Cannot determine Nexowire CLI entrypoint for Hub lifecycle.');
  }
  return {
    executable: options.execPath ?? process.execPath,
    args: [
      ...(options.execArgv ?? process.execArgv),
      cliEntrypoint,
      'http',
    ],
  };
}

export function buildHubLauncher(
  options: HubLifecycleOptions = {},
): string {
  const env = persistedHubEnvironment(options.env ?? process.env);
  const rt = runtime(options);
  const lines = [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
  ];

  for (const [name, value] of Object.entries(env).sort(([a], [b]) =>
    a.localeCompare(b),
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

async function runPowerShellJson<T>(
  script: string,
  env: NodeJS.ProcessEnv,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
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
        env: { ...process.env, ...env },
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
      if ((code ?? -1) !== 0) {
        reject(new Error(err || out || 'PowerShell Hub lifecycle command failed.'));
        return;
      }
      try {
        resolve(JSON.parse(out) as T);
      } catch {
        reject(new Error('Hub Scheduled Task command returned invalid JSON.'));
      }
    });
  });
}

function windowsEnv(options: HubLifecycleOptions): NodeJS.ProcessEnv {
  return {
    ...(options.env ?? process.env),
    NEXOWIRE_HUB_TASK_NAME: taskName(options),
    NEXOWIRE_HUB_LAUNCHER: launcherPath(options),
  };
}

export async function hubLifecycleStatus(
  options: HubLifecycleOptions = {},
): Promise<HubLifecycleStatus> {
  assertWindows();
  const result = await runPowerShellJson<{
    installed: boolean;
    state: string;
  }>(
    [
      "$ErrorActionPreference='Stop'",
      '$name=$env:NEXOWIRE_HUB_TASK_NAME',
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
    name: taskName(options),
    state: result.state,
    autostart: result.installed,
    launcher: launcherPath(options),
    definition: taskName(options),
  });
}

/** Never allow a second lifecycle task to compete with a running legacy Stack supervisor. */
export function legacyStackSupervisorBlocksHubLifecycle(
  taskState: string | null | undefined,
): boolean {
  return taskState?.trim().toLowerCase() === 'running';
}

/** Read-only Windows task inventory; neither starts nor modifies a task. */
export async function inspectLegacyStackHubSupervisor(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  legacyStackTaskState: string | null;
  standaloneHubLifecycleBlocked: boolean;
  mode: 'inspection-only';
}> {
  assertWindows();
  const found = await runPowerShellJson<{state:string|null}>(
    [
      "$ErrorActionPreference='Stop'",
      "$task=Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq 'Nexowire Stack' -and $_.TaskPath -eq '\\' } | Select-Object -First 1",
      "$state=if($null -eq $task){$null}else{[string]$task.State}",
      '[pscustomobject]@{state=$state} | ConvertTo-Json -Compress',
    ].join('\n'),
    env,
  );
  return {
    legacyStackTaskState: found.state,
    standaloneHubLifecycleBlocked: legacyStackSupervisorBlocksHubLifecycle(found.state),
    mode: 'inspection-only',
  };
}

export async function assertNoLegacyStackSupervisor(
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const status = await inspectLegacyStackHubSupervisor(env);
  if (status.standaloneHubLifecycleBlocked) {
    throw new Error(
      'LEGACY_STACK_SUPERVISOR_CONFLICT: The running Nexowire Stack supervises its own Hub. ' +
      'A second Hub task could bind the same port or be replaced by legacy code. ' +
      'Use an owner-approved, reversible supervisor migration; no tasks were changed.',
    );
  }
}

async function writeManifest(options: HubLifecycleOptions): Promise<void> {
  const env = persistedHubEnvironment(options.env ?? process.env);
  await fs.mkdir(rootDir(options), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    manifestPath(options),
    JSON.stringify(
      {
        version: 1,
        platform: 'win32',
        installedAt: new Date().toISOString(),
        persistedEnvNames: Object.keys(env).sort(),
      },
      null,
      2,
    ) + '\n',
    { encoding: 'utf8', mode: 0o600 },
  );
}

export async function installHubLifecycle(
  options: HubLifecycleOptions = {},
): Promise<HubLifecycleStatus> {
  assertWindows();
  persistedHubEnvironment(options.env ?? process.env);
  await assertNoLegacyStackSupervisor(options.env ?? process.env);
  const root = rootDir(options);
  const launcher = launcherPath(options);
  const nextLauncher = buildHubLauncher(options);

  let previousLauncher: string | null = null;
  try {
    previousLauncher = await fs.readFile(
      launcher,
      'utf8',
    );
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error;
    }
  }

  const previousStatus =
    await hubLifecycleStatus(options);
  const installPlan = planHubInstall({
    installed: previousStatus.installed,
    state: previousStatus.state,
    previousLauncher,
    nextLauncher,
  });

  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.writeFile(launcher, nextLauncher, {
    encoding: 'utf8',
    mode: 0o600,
  });

  if (!installPlan.registerTask) {
    let status = previousStatus;
    try {
      if (installPlan.restartTask) {
        status = await restartHubLifecycle(options);
      } else if (installPlan.startTask) {
        status = await startHubLifecycle(options);
      }
    } catch (error) {
      if (previousLauncher === null) {
        await fs.rm(launcher, { force: true });
      } else {
        await fs.writeFile(launcher, previousLauncher, {
          encoding: 'utf8',
          mode: 0o600,
        });
      }
      if (
        previousStatus.state === 'running' &&
        installPlan.restartTask
      ) {
        try {
          await startHubLifecycle(options);
        } catch {
          // Best-effort restore; preserve the original failure.
        }
      }
      throw error;
    }

    await writeManifest(options);
    return status;
  }

  const lifecycleEnv = {
    ...windowsEnv(options),
    NEXOWIRE_HUB_RESTART_REQUIRED: '0',
  };

  await runPowerShellJson<{ ok: boolean }>(
    [
      "$ErrorActionPreference='Stop'",
      '$name=$env:NEXOWIRE_HUB_TASK_NAME',
      '$launcher=$env:NEXOWIRE_HUB_LAUNCHER',
      '$restartRequired=$env:NEXOWIRE_HUB_RESTART_REQUIRED -eq \'1\'',
      '$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name',
      '$argument=\'-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "\' + $launcher.Replace(\'"\',\'""\') + \'"\'',
      "$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument",
      '$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user',
      '$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited',
      '$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew',
      "Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Nexowire first-party Hub' -Force | Out-Null",
      'if ($restartRequired) {',
      '  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue',
      '  $deadline=(Get-Date).AddSeconds(5)',
      '  do {',
      '    $state=(Get-ScheduledTask -TaskName $name).State',
      "    if ($state -ne 'Running') { break }",
      '    Start-Sleep -Milliseconds 100',
      '  } while ((Get-Date) -lt $deadline)',
      '}',
      'Start-ScheduledTask -TaskName $name',
      '[pscustomobject]@{ok=$true} | ConvertTo-Json -Compress',
    ].join('\n'),
    lifecycleEnv,
  );

  await writeManifest(options);
  await new Promise((resolve) => setTimeout(resolve, 250));
  return await hubLifecycleStatus(options);
}

async function controlHub(
  action: 'start' | 'stop' | 'restart',
  options: HubLifecycleOptions,
): Promise<HubLifecycleStatus> {
  assertWindows();
  if (action !== 'stop') {
    await assertNoLegacyStackSupervisor(options.env ?? process.env);
  }
  const commands =
    action === 'restart'
      ? [
          'Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue',
          'Start-ScheduledTask -TaskName $name',
        ]
      : action === 'start'
        ? ['Start-ScheduledTask -TaskName $name']
        : ['Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue'];

  await runPowerShellJson<{ ok: boolean }>(
    [
      "$ErrorActionPreference='Stop'",
      '$name=$env:NEXOWIRE_HUB_TASK_NAME',
      ...commands,
      '[pscustomobject]@{ok=$true} | ConvertTo-Json -Compress',
    ].join('\n'),
    windowsEnv(options),
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  return await hubLifecycleStatus(options);
}

export async function startHubLifecycle(
  options: HubLifecycleOptions = {},
): Promise<HubLifecycleStatus> {
  return await controlHub('start', options);
}

export async function stopHubLifecycle(
  options: HubLifecycleOptions = {},
): Promise<HubLifecycleStatus> {
  return await controlHub('stop', options);
}

export async function restartHubLifecycle(
  options: HubLifecycleOptions = {},
): Promise<HubLifecycleStatus> {
  return await controlHub('restart', options);
}

export async function uninstallHubLifecycle(
  options: HubLifecycleOptions = {},
): Promise<{ removed: boolean; name: string }> {
  assertWindows();
  const result = await runPowerShellJson<{ removed: boolean }>(
    [
      "$ErrorActionPreference='Stop'",
      '$name=$env:NEXOWIRE_HUB_TASK_NAME',
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
  await fs.rm(rootDir(options), { recursive: true, force: true });
  return { removed: result.removed, name: taskName(options) };
}

export async function runHubLifecycleCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const action = args[0] ?? 'status';
  const options: HubLifecycleOptions = { env };
  let result: unknown;

  switch (action) {
    case 'install':
      result = await installHubLifecycle(options);
      break;
    case 'status':
      result = await hubLifecycleStatus(options);
      break;
    case 'preflight':
      result = await inspectLegacyStackHubSupervisor(env);
      break;
    case 'start':
      result = await startHubLifecycle(options);
      break;
    case 'stop':
      result = await stopHubLifecycle(options);
      break;
    case 'restart':
      result = await restartHubLifecycle(options);
      break;
    case 'uninstall':
      result = await uninstallHubLifecycle(options);
      break;
    default:
      throw new Error(
        'Usage: nexowire hub [preflight|install|status|start|stop|restart|uninstall]',
      );
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
