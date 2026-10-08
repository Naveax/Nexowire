import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrivilegedBrokerClient } from '../agent/privileged-broker-client.js';
import { loadOrCreatePrivilegedBrokerToken } from '../security/privileged-broker-secret.js';
import {
  applyLatestLiveUpdate,
  checkLiveUpdate,
  type UpdateCheckResult,
} from './live-update.js';

export const AUTO_UPDATE_TASK_NAME = 'Nexowire Automatic Update';
export const AUTO_UPDATE_INTERVAL_MINUTES = 60;

type AutomaticUpdateAction =
  | 'up_to_date'
  | 'update_scheduled'
  | 'broker_unavailable'
  | 'failed';

export interface AutomaticUpdateResult {
  checkedAt: string;
  action: AutomaticUpdateAction;
  currentVersion: string | null;
  latestVersion: string | null;
  detail: string | null;
}

export interface AutomaticUpdateDependencies {
  check: () => Promise<UpdateCheckResult>;
  broker: () => Promise<PrivilegedBrokerClient | null>;
  apply: (client: PrivilegedBrokerClient) => Promise<{
    scheduled: boolean;
  }>;
}

export async function executeAutomaticUpdate(
  input: AutomaticUpdateDependencies,
): Promise<AutomaticUpdateResult> {
  const checkedAt = new Date().toISOString();
  const check = await input.check();
  if (!check.updateAvailable) {
    return {
      checkedAt,
      action: 'up_to_date',
      currentVersion: check.currentVersion,
      latestVersion: check.latestVersion,
      detail: null,
    };
  }
  // Never partially update the user-side runtime while the machine's
  // SYSTEM Hub / elevated Broker path cannot be reached and authorized.
  const client = await input.broker();
  if (!client) {
    return {
      checkedAt,
      action: 'broker_unavailable',
      currentVersion: check.currentVersion,
      latestVersion: check.latestVersion,
      detail: 'Existing authorized Privileged Broker is unavailable; update deferred.',
    };
  }
  const status = await client.probe();
  if (!status.reachable || !status.elevated) {
    return {
      checkedAt,
      action: 'broker_unavailable',
      currentVersion: check.currentVersion,
      latestVersion: check.latestVersion,
      detail: 'Authorized elevated Broker is offline; update deferred without UAC.',
    };
  }
  const result = await input.apply(client);
  return {
    checkedAt,
    action: result.scheduled ? 'update_scheduled' : 'up_to_date',
    currentVersion: check.currentVersion,
    latestVersion: check.latestVersion,
    detail: result.scheduled
      ? 'Official verified update staged. Post-cutover health/rollback remains pending.'
      : null,
  };
}

function psLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function updaterDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.nexowire', 'auto-update');
}

function appData(): string {
  const value = process.env.LOCALAPPDATA;
  if (!value) {
    throw new Error('LOCALAPPDATA required for Windows automatic update.');
  }
  return path.resolve(value);
}

function installedRuntime(): {
  executable: string;
  cli: string;
} {
  const executable = path.resolve(process.execPath);
  const cli = path.resolve(process.argv[1] ?? '');
  const versions = path.win32.resolve(
    appData(),
    'Nexowire',
    'versions',
  ).toLowerCase() + '\\';
  if (
    !executable.toLowerCase().startsWith(versions) ||
    !cli.toLowerCase().startsWith(versions) ||
    !executable.toLowerCase().endsWith('\\runtime\\node.exe') ||
    !cli.toLowerCase().endsWith('\\app\\dist\\src\\cli.js')
  ) {
    throw new Error(
      'Automatic updater may only install from an official versioned Windows runtime.',
    );
  }
  if (
    path.win32.dirname(path.win32.dirname(executable)).toLowerCase() !==
    path.win32.resolve(cli, '..', '..', '..', '..').toLowerCase()
  ) {
    throw new Error('Updater runtime and CLI must belong to the same installed build.');
  }
  return { executable, cli };
}

export function renderAutoUpdateLauncher(
  executable: string,
  cli: string,
): string {
  return [
    "$ErrorActionPreference='Stop'",
    '& ' + psLiteral(executable) + ' ' +
      psLiteral(cli) + " 'update' 'auto' 'run'",
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n');
}

export function renderAutoUpdateTaskInstallScript(
  launcher: string,
): string {
  return [
    "$ErrorActionPreference='Stop'",
    '$name=' + psLiteral(AUTO_UPDATE_TASK_NAME),
    '$launcher=' + psLiteral(launcher),
    '$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name',
    '$existing=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue',
    'if($existing -and [string]$existing.State -eq "Disabled"){[pscustomobject]@{installed=$true;ownerDisabled=$true;taskName=$name}|ConvertTo-Json -Compress;exit 0}',
    "$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"' + $launcher.Replace('\"','\"\"') + '\"')",
    '$logon=New-ScheduledTaskTrigger -AtLogOn -User $user',
    '$hour=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 60) -RepetitionDuration (New-TimeSpan -Days 3650)',
    '$hour.Repetition.Duration=$null',
    '$hour.Repetition.StopAtDurationEnd=$false',
    '$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
    '$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited',
    "Register-ScheduledTask -TaskName $name -Action $action -Trigger @($logon,$hour) -Principal $principal -Settings $settings -Description 'Nexowire official update check once per hour; no UAC elevation' -Force | Out-Null",
    '$task=Get-ScheduledTask -TaskName $name',
    '$expectedSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '$actualSid=([Security.Principal.NTAccount]$task.Principal.UserId).Translate([Security.Principal.SecurityIdentifier]).Value',
    "if($actualSid -ne $expectedSid -or $task.Principal.RunLevel -ne 'Limited' -or @($task.Triggers).Count -ne 2){throw 'AUTO_UPDATE_TASK_VALIDATION_FAILED'}",
    'Start-ScheduledTask -TaskName $name',
    '[pscustomobject]@{installed=$true;taskName=$name;user=$user;intervalMinutes=60;runLevel="Limited";restartPolicy="IgnoreNew"}|ConvertTo-Json -Compress',
    '',
  ].join('\r\n');
}

async function runPowerShellJson(
  script: string,
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', script,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8').trim();
      if (code !== 0) {
        reject(new Error(
          Buffer.concat(stderr).toString('utf8').trim() ||
          out ||
          'Automatic update scheduled-task command failed.',
        ));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error('Automatic update task returned invalid JSON.'));
      }
    });
  });
}

async function writeAutoStatus(
  result: AutomaticUpdateResult,
): Promise<void> {
  const directory = updaterDir();
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'last-check.json');
  const temporary = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(
    temporary,
    JSON.stringify(result, null, 2) + '\n',
    'utf8',
  );
  await fs.rename(temporary, file);
}

async function runAutoUpdateOnce(): Promise<AutomaticUpdateResult> {
  const directory = updaterDir();
  await fs.mkdir(directory, { recursive: true });
  // wx locking prevents overlapping hourly task instances and
  // explicit 'update auto run' calls for the same Windows user.
  const lockFile = path.join(directory, 'run.lock');
  let lock;
  try {
    lock = await fs.open(lockFile, 'wx', 0o600);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EEXIST'
    ) {
      throw new Error(
        'Updater already running or a stale lock exists. Safe skip; no forced unlock.',
      );
    }
    throw error;
  }
  try {
    const result = await executeAutomaticUpdate({
      check: () => checkLiveUpdate(),
      broker: async () => {
        // The same DPAPI CurrentUser token used by the existing elevated
        // Broker is loaded for the same user; never write it to task XML.
        const token = await loadOrCreatePrivilegedBrokerToken();
        return new PrivilegedBrokerClient({
          url: 'http://127.0.0.1:43112',
          token,
        });
      },
      apply: (client) => applyLatestLiveUpdate({
        privilegedBroker: client,
        requireMachineUpdate: true,
      }),
    });
    await writeAutoStatus(result);
    return result;
  } catch (error) {
    const result: AutomaticUpdateResult = {
      checkedAt: new Date().toISOString(),
      action: 'failed',
      currentVersion: null,
      latestVersion: null,
      detail: error instanceof Error ? error.message : String(error),
    };
    await writeAutoStatus(result);
    throw error;
  } finally {
    await lock.close();
    await fs.rm(lockFile, { force: true });
  }
}

async function installAutoUpdateTask(): Promise<unknown> {
  if (process.platform !== 'win32') {
    throw new Error('Automatic update task is available on Windows only.');
  }
  const { executable, cli } = installedRuntime();
  const directory = updaterDir();
  await fs.mkdir(directory, { recursive: true });
  const launcher = path.join(directory, 'launch.ps1');
  await fs.writeFile(
    launcher,
    renderAutoUpdateLauncher(executable, cli),
    'utf8',
  );
  return await runPowerShellJson(
    renderAutoUpdateTaskInstallScript(launcher),
  );
}

async function autoUpdateTaskStatus(): Promise<unknown> {
  const result = await runPowerShellJson([
    "$ErrorActionPreference='Stop'",
    '$name=' + psLiteral(AUTO_UPDATE_TASK_NAME),
    '$task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue',
    'if($null-eq$task){[pscustomobject]@{installed=$false}|ConvertTo-Json -Compress;exit 0}',
    '$info=Get-ScheduledTaskInfo -TaskName $name',
    '[pscustomobject]@{installed=$true;state=[string]$task.State;runLevel=[string]$task.Principal.RunLevel;lastResult=$info.LastTaskResult;lastRun=$info.LastRunTime.ToString("o");intervalMinutes=60}|ConvertTo-Json -Compress',
  ].join('\n'));
  let lastCheck: unknown = null;
  try {
    lastCheck = JSON.parse(
      await fs.readFile(
        path.join(updaterDir(), 'last-check.json'), 'utf8',
      ),
    ) as unknown;
  } catch (error) {
    if (!(typeof error === 'object' && error !== null &&
      'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  return { task: result, lastCheck };
}

export async function runAutoUpdateCommand(
  args: readonly string[],
): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('Windows hourly automatic updater requires Windows.');
  }
  const action = args[0] ?? 'status';
  let output: unknown;
  switch (action) {
    case 'install':
      output = await installAutoUpdateTask();
      break;
    case 'run':
      output = await runAutoUpdateOnce();
      break;
    case 'status':
      output = await autoUpdateTaskStatus();
      break;
    case 'enable':
    case 'disable':
    case 'uninstall': {
      const command = action === 'disable'
        ? 'Disable-ScheduledTask -TaskName $name -ErrorAction Stop|Out-Null'
        : action === 'enable'
          ? 'Enable-ScheduledTask -TaskName $name -ErrorAction Stop|Out-Null;Start-ScheduledTask -TaskName $name'
          : 'Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop';
      output = await runPowerShellJson([
        "$ErrorActionPreference='Stop'",
        '$name=' + psLiteral(AUTO_UPDATE_TASK_NAME),
        command,
        '[pscustomobject]@{action=' + psLiteral(action) + ';success=$true}|ConvertTo-Json -Compress',
      ].join('\n'));
      break;
    }
    default:
      throw new Error(
        'Usage: nexowire update auto [install|run|status|enable|disable|uninstall]',
      );
  }
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}
