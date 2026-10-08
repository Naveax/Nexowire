import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as z from 'zod';
import { isWindowsProcessElevated } from './privileged-broker.js';
import { hardenWindowsProgramDataAcl } from '../security/windows-programdata-acl.js';
import {
  defaultPrivilegedBrokerSecretFile,
  loadOrCreatePrivilegedBrokerToken,
} from '../security/privileged-broker-secret.js';

const TASK_NAME_DEFAULT = 'Nexowire Privileged Broker';

const TaskStatusSchema = z.object({
  installed: z.boolean(),
  taskName: z.string(),
  state: z.string().nullable(),
  lastRunTime: z.string().nullable(),
  lastTaskResult: z.number().nullable(),
  nextRunTime: z.string().nullable(),
});

export type PrivilegedBrokerTaskStatus = z.infer<
  typeof TaskStatusSchema
>;

export interface PrivilegedBrokerTaskOptions {
  env?: NodeJS.ProcessEnv;
  cliEntrypoint?: string;
  execPath?: string;
  execArgv?: readonly string[];
  taskName?: string;
  rootDir?: string;
}

function psLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function taskName(
  options: PrivilegedBrokerTaskOptions,
): string {
  const value =
    options.taskName ??
    options.env?.NEXOWIRE_PRIVILEGED_BROKER_TASK_NAME ??
    TASK_NAME_DEFAULT;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) {
    throw new Error(
      'Privileged broker task name must be 1-128 characters.',
    );
  }
  return trimmed;
}

function rootDir(
  options: PrivilegedBrokerTaskOptions,
): string {
  if (options.rootDir) return options.rootDir;
  if (process.platform === 'win32') {
    const base =
      options.env?.ProgramData ??
      process.env.ProgramData ??
      'C:\\ProgramData';
    return path.join(
      base,
      'Nexowire',
      'privileged-broker',
    );
  }
  return path.join(
    os.homedir(),
    '.nexowire',
    'privileged-broker',
  );
}

function hardenPrivilegedBrokerAcl(root: string): void {
  hardenWindowsProgramDataAcl(root);
}

function launcherPath(
  options: PrivilegedBrokerTaskOptions,
): string {
  return path.join(rootDir(options), 'launch.ps1');
}

function manifestPath(
  options: PrivilegedBrokerTaskOptions,
): string {
  return path.join(rootDir(options), 'task.json');
}

async function runPowerShellJson<T>(
  script: string,
  env: NodeJS.ProcessEnv,
): Promise<T> {
  if (process.platform !== 'win32') {
    throw new Error(
      'Privileged broker task lifecycle is available only on Windows.',
    );
  }

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
        env: {
          ...process.env,
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) =>
      stdout.push(chunk),
    );
    child.stderr.on('data', (chunk: Buffer) =>
      stderr.push(chunk),
    );

    child.once('error', reject);
    child.once('close', (code) => {
      const out = Buffer.concat(stdout)
        .toString('utf8')
        .trim();
      const err = Buffer.concat(stderr)
        .toString('utf8')
        .trim();

      if (code !== 0) {
        reject(
          new Error(
            err ||
              out ||
              'Privileged broker scheduled-task command failed.',
          ),
        );
        return;
      }

      try {
        resolve(JSON.parse(out) as T);
      } catch {
        reject(
          new Error(
            'Privileged broker scheduled-task command returned invalid JSON.',
          ),
        );
      }
    });
  });
}

export function buildPrivilegedBrokerLauncher(
  options: PrivilegedBrokerTaskOptions,
): string {
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const cliEntrypoint =
    options.cliEntrypoint ?? process.argv[1];
  if (!cliEntrypoint) {
    throw new Error(
      'Cannot determine Nexowire CLI entrypoint for broker task.',
    );
  }
  const execArgv = [
    ...(options.execArgv ?? process.execArgv),
    cliEntrypoint,
    'privileged-broker',
    'run',
  ];

  const lines = [
    "$ErrorActionPreference='Stop'",
  ];

  const brokerHost =
    env.NEXOWIRE_PRIVILEGED_BROKER_HOST?.trim();
  const brokerPort =
    env.NEXOWIRE_PRIVILEGED_BROKER_PORT?.trim();
  const secretFile =
    env.NEXOWIRE_PRIVILEGED_BROKER_SECRET_FILE?.trim();

  if (brokerHost) {
    lines.push(
      '$env:NEXOWIRE_PRIVILEGED_BROKER_HOST=' +
        psLiteral(brokerHost),
    );
  }
  if (brokerPort) {
    lines.push(
      '$env:NEXOWIRE_PRIVILEGED_BROKER_PORT=' +
        psLiteral(brokerPort),
    );
  }
  if (secretFile) {
    lines.push(
      '$env:NEXOWIRE_PRIVILEGED_BROKER_SECRET_FILE=' +
        psLiteral(secretFile),
    );
  }

  lines.push(
    '& ' +
      psLiteral(execPath) +
      ' ' +
      execArgv.map(psLiteral).join(' '),
    'exit $LASTEXITCODE',
    '',
  );
  return lines.join('\r\n');
}

function lifecycleEnv(
  name: string,
  launcher: string,
): NodeJS.ProcessEnv {
  return {
    NEXOWIRE_BROKER_TASK_NAME: name,
    NEXOWIRE_BROKER_LAUNCHER: launcher,
  };
}

export const privilegedBrokerStatusScript = `
$ErrorActionPreference='Stop'
$name=$env:NEXOWIRE_BROKER_TASK_NAME
$task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($null -eq $task) {
  [pscustomobject]@{
    installed=$false
    taskName=$name
    state=$null
    lastRunTime=$null
    lastTaskResult=$null
    nextRunTime=$null
  } | ConvertTo-Json -Compress
  exit 0
}
$info=$task | Get-ScheduledTaskInfo
[pscustomobject]@{
  installed=$true
  taskName=$name
  state=[string]$task.State
  lastRunTime=if ($null -eq $info.LastRunTime -or $info.LastRunTime -eq [datetime]::MinValue) {$null} else {$info.LastRunTime.ToString('o')}
  lastTaskResult=[int]$info.LastTaskResult
  nextRunTime=if ($null -eq $info.NextRunTime -or $info.NextRunTime -eq [datetime]::MinValue) {$null} else {$info.NextRunTime.ToString('o')}
} | ConvertTo-Json -Compress
`;

export async function privilegedBrokerTaskStatus(
  options: PrivilegedBrokerTaskOptions = {},
): Promise<PrivilegedBrokerTaskStatus> {
  const name = taskName(options);
  const decoded = await runPowerShellJson<unknown>(
    privilegedBrokerStatusScript,
    lifecycleEnv(name, launcherPath(options)),
  );
  return TaskStatusSchema.parse(decoded);
}

/**
 * Crash/termination recovery for the elevated per-user broker. The task
 * stays Interactive/Highest under its existing Windows user; it does not
 * grant SYSTEM rights or elevate arbitrary capabilities.
 */
export const PRIVILEGED_BROKER_TASK_RECOVERY_SETTINGS = String.raw`
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
`;

export async function installPrivilegedBrokerTask(
  options: PrivilegedBrokerTaskOptions = {},
): Promise<{
  status: PrivilegedBrokerTaskStatus;
  launcher: string;
  secretFile: string;
}> {
  if (process.platform !== 'win32') {
    throw new Error(
      'Privileged broker task installation requires Windows.',
    );
  }
  if (!isWindowsProcessElevated()) {
    throw new Error(
      'Privileged broker task installation must run from an elevated Windows process.',
    );
  }

  const env = options.env ?? process.env;
  if (
    env.NEXOWIRE_PRIVILEGED_BROKER_TOKEN?.trim() ||
    env.NEXOWIRE_PRIVILEGED_BROKER_TOKENS?.trim()
  ) {
    throw new Error(
      'The broker task installer refuses to persist plaintext broker-token configuration. Unset explicit broker tokens and use the DPAPI-protected default secret.',
    );
  }

  const directory = rootDir(options);
  const launcher = launcherPath(options);
  const name = taskName(options);
  const secretFile =
    env.NEXOWIRE_PRIVILEGED_BROKER_SECRET_FILE?.trim() ||
    defaultPrivilegedBrokerSecretFile();

  await loadOrCreatePrivilegedBrokerToken({
    file: secretFile,
  });

  await fs.mkdir(directory, {
    recursive: true,
    mode: 0o700,
  });
  // Repair a stale launcher DACL before overwriting an existing install.
  hardenPrivilegedBrokerAcl(directory);
  await fs.writeFile(
    launcher,
    buildPrivilegedBrokerLauncher(options),
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );
  hardenPrivilegedBrokerAcl(directory);

  const installScript = `
$ErrorActionPreference='Stop'
$name=$env:NEXOWIRE_BROKER_TASK_NAME
$launcher=$env:NEXOWIRE_BROKER_LAUNCHER
$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$argument='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $launcher.Replace('"','""') + '"'
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
${PRIVILEGED_BROKER_TASK_RECOVERY_SETTINGS}
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Nexowire elevated privileged broker' -Force | Out-Null
Start-ScheduledTask -TaskName $name
[pscustomobject]@{ ok=$true } | ConvertTo-Json -Compress
`;
  await runPowerShellJson<{ ok: boolean }>(
    installScript,
    lifecycleEnv(name, launcher),
  );

  await fs.writeFile(
    manifestPath(options),
    JSON.stringify(
      {
        version: 1,
        taskName: name,
        launcher,
        secretFile,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
    { encoding: 'utf8', mode: 0o600 },
  );
  hardenPrivilegedBrokerAcl(directory);

  return {
    status: await privilegedBrokerTaskStatus(options),
    launcher,
    secretFile,
  };
}

export async function startPrivilegedBrokerTask(
  options: PrivilegedBrokerTaskOptions = {},
): Promise<PrivilegedBrokerTaskStatus> {
  const name = taskName(options);
  const script = `
$ErrorActionPreference='Stop'
$name=$env:NEXOWIRE_BROKER_TASK_NAME
$task=Get-ScheduledTask -TaskName $name -ErrorAction Stop
Start-ScheduledTask -TaskName $name
[pscustomobject]@{ ok=$true } | ConvertTo-Json -Compress
`;
  await runPowerShellJson<{ ok: boolean }>(
    script,
    lifecycleEnv(name, launcherPath(options)),
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  return await privilegedBrokerTaskStatus(options);
}

export async function stopPrivilegedBrokerTask(
  options: PrivilegedBrokerTaskOptions = {},
): Promise<PrivilegedBrokerTaskStatus> {
  const name = taskName(options);
  const script = `
$ErrorActionPreference='Stop'
$name=$env:NEXOWIRE_BROKER_TASK_NAME
$task=Get-ScheduledTask -TaskName $name -ErrorAction Stop
Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
[pscustomobject]@{ ok=$true } | ConvertTo-Json -Compress
`;
  await runPowerShellJson<{ ok: boolean }>(
    script,
    lifecycleEnv(name, launcherPath(options)),
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  return await privilegedBrokerTaskStatus(options);
}

export async function uninstallPrivilegedBrokerTask(
  options: PrivilegedBrokerTaskOptions = {},
): Promise<{
  removed: boolean;
  taskName: string;
}> {
  if (process.platform !== 'win32') {
    throw new Error(
      'Privileged broker task removal requires Windows.',
    );
  }
  if (!isWindowsProcessElevated()) {
    throw new Error(
      'Privileged broker task removal must run from an elevated Windows process.',
    );
  }

  const name = taskName(options);
  const script = `
$ErrorActionPreference='Stop'
$name=$env:NEXOWIRE_BROKER_TASK_NAME
$task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($null -ne $task) {
  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
  [pscustomobject]@{ removed=$true } | ConvertTo-Json -Compress
} else {
  [pscustomobject]@{ removed=$false } | ConvertTo-Json -Compress
}
`;
  const result = await runPowerShellJson<{ removed: boolean }>(
    script,
    lifecycleEnv(name, launcherPath(options)),
  );
  await fs.rm(rootDir(options), {
    recursive: true,
    force: true,
  });
  return {
    removed: result.removed,
    taskName: name,
  };
}

export async function runPrivilegedBrokerLifecycleCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const command = args[0] ?? 'status';
  const options: PrivilegedBrokerTaskOptions = { env };

  let result: unknown;
  switch (command) {
    case 'install':
      result = await installPrivilegedBrokerTask(options);
      break;
    case 'status':
      result = await privilegedBrokerTaskStatus(options);
      break;
    case 'start':
      result = await startPrivilegedBrokerTask(options);
      break;
    case 'stop':
      result = await stopPrivilegedBrokerTask(options);
      break;
    case 'uninstall':
      result = await uninstallPrivilegedBrokerTask(options);
      break;
    default:
      throw new Error(
        'Usage: nexowire privileged-broker [run|install|status|start|stop|uninstall]',
      );
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
