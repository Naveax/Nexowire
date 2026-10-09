import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod';
import { isWindowsProcessElevated } from '../agent/privileged-broker.js';
import { hardenWindowsProgramDataAcl } from '../security/windows-programdata-acl.js';
import {
  assertNoPrivilegedNodeStartupFlags,
  assertWindowsPrivilegedRuntimeTrusted,
  PRIVILEGED_NODE_INJECTION_ENV,
} from '../security/windows-privileged-runtime-trust.js';
import {
  inspectProtectedSecretFile,
  readProtectedSecretFile,
  writeProtectedSecretFile,
} from '../security/protected-secret-files.js';
import {
  persistedHubEnvironment,
  assertNoLegacyStackSupervisor,
  type HubLifecycleOptions,
} from './hub-lifecycle.js';

const TRUSTED_SYSTEM32='C:\\Windows\\System32';
const TRUSTED_POWERSHELL=TRUSTED_SYSTEM32+'\\WindowsPowerShell\\v1.0\\powershell.exe';
const TRUSTED_POWERSHELL_DIR=TRUSTED_SYSTEM32+'\\WindowsPowerShell\\v1.0';

/**
 * Task lifecycle scripts need only task names and protected launcher path.
 * Never propagate a caller-controlled PATH/PSModulePath or process hooks to
 * the elevated PowerShell task registration process.
 */
export function protectedHubTaskShellEnvironment(input:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
  const taskVariables=[
    'NEXOWIRE_HUB_BOOT_TASK_NAME',
    'NEXOWIRE_HUB_TASK_NAME',
    'NEXOWIRE_HUB_BOOT_LAUNCHER',
  ] as const;
  const result:NodeJS.ProcessEnv={
    SystemRoot:'C:\\Windows',
    windir:'C:\\Windows',
    ComSpec:TRUSTED_SYSTEM32+'\\cmd.exe',
    PATH:[TRUSTED_SYSTEM32,'C:\\Windows',TRUSTED_POWERSHELL_DIR].join(';'),
    PSModulePath:TRUSTED_POWERSHELL_DIR+'\\Modules',
  };
  for(const name of taskVariables){
    const value=input[name];
    if(!value||typeof value!=='string'||value.length>4096){
      throw new Error('HUB_BOOT_TASK_ENV_INVALID: '+name);
    }
    result[name]=value;
  }
  return result;
}

const BOOT_TASK_DEFAULT = 'Nexowire Hub Boot';
const USER_TASK_DEFAULT = 'Nexowire Hub';

const BootStatusSchema = z.object({
  installed: z.boolean(),
  state: z.string(),
  taskName: z.string(),
  userTaskState: z.string(),
  launcher: z.string(),
  secretFile: z.string(),
  pidFile: z.string(),
  pid: z.number().int().positive().nullable(),
});

export type HubBootLifecycleStatus = z.infer<
  typeof BootStatusSchema
>;

export interface HubBootLifecycleOptions
  extends HubLifecycleOptions {
  bootTaskName?: string;
  programDataDir?: string;
}

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new Error(
      'Nexowire Hub boot lifecycle requires Windows.',
    );
  }
}

function assertElevated(): void {
  assertWindows();
  if (!isWindowsProcessElevated()) {
    throw new Error(
      'Nexowire Hub boot lifecycle installation requires an elevated Windows process.',
    );
  }
}

function bootTaskName(
  options: HubBootLifecycleOptions,
): string {
  const value =
    options.bootTaskName ??
    options.env?.NEXOWIRE_HUB_BOOT_TASK_NAME ??
    BOOT_TASK_DEFAULT;
  const name = value.trim();
  if (!name || name.length > 128) {
    throw new Error(
      'Hub boot Scheduled Task name must be 1-128 characters.',
    );
  }
  return name;
}

function userTaskName(
  options: HubBootLifecycleOptions,
): string {
  const value =
    options.windowsTaskName ??
    options.env?.NEXOWIRE_HUB_TASK_NAME ??
    USER_TASK_DEFAULT;
  const name = value.trim();
  if (!name || name.length > 128) {
    throw new Error(
      'Hub Scheduled Task name must be 1-128 characters.',
    );
  }
  return name;
}

function programDataRoot(
  options: HubBootLifecycleOptions,
): string {
  const base =
    options.programDataDir ??
    options.env?.ProgramData ??
    process.env.ProgramData ??
    'C:\\ProgramData';
  return path.join(base, 'Nexowire', 'hub-boot');
}

function pathsFor(
  options: HubBootLifecycleOptions,
) {
  const root = programDataRoot(options);
  return {
    root,
    launcher: path.join(root, 'launch.ps1'),
    secret: path.join(
      root,
      'control-plane-service-token.machine.dpapi.json',
    ),
    manifest: path.join(root, 'lifecycle.json'),
    pid: path.join(root, 'hub.pid'),
  };
}

function currentUserHubLauncher(
  options: HubBootLifecycleOptions,
): string {
  return path.join(
    options.homeDir ?? os.homedir(),
    '.nexowire',
    'hub-service',
    'launch.ps1',
  );
}

function psLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

export function parsePersistedHubLauncherEnvironment(
  launcher: string,
): Record<string, string> {
  const decoded: Record<string, string> = {};
  for (const line of launcher.split(/\r?\n/)) {
    const match =
      /^\$env:([A-Z0-9_]+)='((?:[^']|'')*)'$/.exec(
        line.trim(),
      );
    if (!match) continue;
    decoded[match[1]!] = match[2]!.replaceAll("''", "'");
  }
  return persistedHubEnvironment(decoded);
}

function runtime(
  options: HubBootLifecycleOptions,
): {
  executable: string;
  args: string[];
} {
  const cliEntrypoint =
    options.cliEntrypoint ?? process.argv[1];
  if (!cliEntrypoint) {
    throw new Error(
      'Cannot determine Nexowire CLI entrypoint for Hub boot lifecycle.',
    );
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

function psArgument(value: string): string {
  if (value.includes('"')) {
    throw new Error(
      'Hub boot process arguments must not contain a double quote.',
    );
  }
  return '"' + value + '"';
}

export function buildHubBootLauncher(input: {
  env: NodeJS.ProcessEnv;
  executable: string;
  args: readonly string[];
  pidFile: string;
}): string {
  const env = persistedHubEnvironment(input.env);
  const lines = [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
  ];
  for (const [name, value] of Object.entries(env).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    lines.push(
      '$env:' + name + '=' + psLiteral(value),
    );
  }

  // SYSTEM tasks must not inherit caller/user/machine Node preload hooks.
  lines.push('Remove-Item -Path ' +
    PRIVILEGED_NODE_INJECTION_ENV.map(name=>`Env:${name}`).join(',') +
    ' -ErrorAction SilentlyContinue');

  const argumentList =
    '@(' +
    input.args.map((entry) =>
      psLiteral(psArgument(entry)),
    ).join(',') +
    ')';

  lines.push(
    '$pidFile=' + psLiteral(input.pidFile),
    'Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue',
    '$process=Start-Process -FilePath ' +
      psLiteral(input.executable) +
      ' -ArgumentList ' +
      argumentList +
      ' -WindowStyle Hidden -PassThru',
    '$process.Id.ToString() | Set-Content -LiteralPath $pidFile -Encoding ASCII',
    'try {',
    '  $process.WaitForExit()',
    '  exit $process.ExitCode',
    '} finally {',
    '  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue',
    '}',
    '',
  );
  return lines.join('\r\n');
}

async function runPowerShellJson<T>(
  script: string,
  env: NodeJS.ProcessEnv,
): Promise<T> {
  assertWindows();
  return await new Promise<T>((resolve, reject) => {
    const child = spawn(
      TRUSTED_POWERSHELL,
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
        shell:false,cwd:TRUSTED_SYSTEM32,
        env: protectedHubTaskShellEnvironment(env),
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
      if ((code ?? -1) !== 0) {
        reject(
          new Error(
            err ||
              out ||
              'PowerShell Hub boot lifecycle command failed.',
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(out) as T);
      } catch {
        reject(
          new Error(
            'Hub boot Scheduled Task command returned invalid JSON.',
          ),
        );
      }
    });
  });
}

function taskEnv(
  options: HubBootLifecycleOptions,
): NodeJS.ProcessEnv {
  const p = pathsFor(options);
  return {
    ...(options.env ?? process.env),
    NEXOWIRE_HUB_BOOT_TASK_NAME:
      bootTaskName(options),
    NEXOWIRE_HUB_TASK_NAME:
      userTaskName(options),
    NEXOWIRE_HUB_BOOT_LAUNCHER:
      p.launcher,
  };
}

async function readPid(
  file: string,
): Promise<number | null> {
  try {
    const raw = (await fs.readFile(file, 'utf8')).trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0
      ? pid
      : null;
  } catch {
    return null;
  }
}

function processAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForBootHub(
  port: number,
  pidFile: string,
  timeoutMs = 20_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'Hub process did not become ready.';
  while (Date.now() < deadline) {
    const pid = await readPid(pidFile);
    if (pid && processAlive(pid)) {
      try {
        const response = await fetch(
          'http://127.0.0.1:' + port + '/health',
          { signal: AbortSignal.timeout(1_500) },
        );
        if (response.ok) return pid;
        lastError =
          'Hub health returned HTTP ' +
          response.status +
          '.';
      } catch (error) {
        lastError =
          error instanceof Error
            ? error.message
            : String(error);
      }
    }
    await new Promise((resolve) =>
      setTimeout(resolve, 250),
    );
  }
  throw new Error(
    'Boot Hub did not become healthy: ' +
      lastError,
  );
}

function hardenProgramDataAcl(root: string): void {
  hardenWindowsProgramDataAcl(root);
}

async function writeManifest(
  options: HubBootLifecycleOptions,
  sourceSecretFile: string,
  port: number,
): Promise<void> {
  const p = pathsFor(options);
  await fs.writeFile(
    p.manifest,
    JSON.stringify(
      {
        version: 1,
        installedAt: new Date().toISOString(),
        taskName: bootTaskName(options),
        userTaskName: userTaskName(options),
        launcher: p.launcher,
        secretFile: p.secret,
        sourceSecretFile,
        port,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
}

export async function hubBootLifecycleStatus(
  options: HubBootLifecycleOptions = {},
): Promise<HubBootLifecycleStatus> {
  assertWindows();
  const p = pathsFor(options);
  const result = await runPowerShellJson<{
    installed: boolean;
    state: string;
    userTaskState: string;
  }>(
    [
      "$ErrorActionPreference='Stop'",
      '$boot=$env:NEXOWIRE_HUB_BOOT_TASK_NAME',
      '$user=$env:NEXOWIRE_HUB_TASK_NAME',
      '$bootTask=Get-ScheduledTask -TaskName $boot -ErrorAction SilentlyContinue',
      '$userTask=Get-ScheduledTask -TaskName $user -ErrorAction SilentlyContinue',
      "$bootState=if($bootTask){([string]$bootTask.State).ToLowerInvariant()}else{'not-installed'}",
      "$userState=if($userTask){([string]$userTask.State).ToLowerInvariant()}else{'not-installed'}",
      '[pscustomobject]@{installed=($null-ne$bootTask);state=$bootState;userTaskState=$userState}|ConvertTo-Json -Compress',
    ].join('\n'),
    taskEnv(options),
  );
  const pid = await readPid(p.pid);
  return BootStatusSchema.parse({
    installed: result.installed,
    state: result.state,
    taskName: bootTaskName(options),
    userTaskState: result.userTaskState,
    launcher: p.launcher,
    secretFile: p.secret,
    pid: pid && processAlive(pid) ? pid : null,
    pidFile: p.pid,
  });
}

export async function installHubBootLifecycle(
  options: HubBootLifecycleOptions = {},
): Promise<HubBootLifecycleStatus> {
  assertElevated();
  // Fail before reading/writing protected DPAPI secrets or touching tasks:
  // a running legacy Stack would respawn its old Hub on the same port.
  await assertNoLegacyStackSupervisor(options.env ?? process.env);
  // A protected task must NEVER persist a Node/CLI command pointing into
  // user-writable AppData, a staging directory, or an untrusted ProgramData
  // package. Validate the executable and complete local code tree before
  // unsealing or writing any control-plane/DPAPI secrets.
  const rt = runtime(options);
  assertNoPrivilegedNodeStartupFlags(options.execArgv ?? process.execArgv);
  assertWindowsPrivilegedRuntimeTrusted({
    executable: rt.executable,
    cliEntrypoint: options.cliEntrypoint ?? process.argv[1]!,
    env: options.env ?? process.env,
  });

  const currentLauncher =
    currentUserHubLauncher(options);
  const launcherText = await fs.readFile(
    currentLauncher,
    'utf8',
  );
  const sourceEnv =
    parsePersistedHubLauncherEnvironment(
      launcherText,
    );
  const sourceSecretFile =
    sourceEnv
      .NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_DPAPI_FILE;
  if (!sourceSecretFile) {
    throw new Error(
      'Hub boot install requires an existing current-user DPAPI control-plane service-token source.',
    );
  }

  const sourceSecretMetadata =
    inspectProtectedSecretFile(sourceSecretFile);
  if (
    sourceSecretMetadata.protection !==
    'windows-dpapi-current-user'
  ) {
    throw new Error(
      'Hub boot install expected the existing service token to use current-user DPAPI.',
    );
  }
  const serviceToken = readProtectedSecretFile(
    sourceSecretFile,
    'control-plane-service-token',
    'control-plane service token',
  );

  const p = pathsFor(options);
  await fs.mkdir(p.root, {
    recursive: true,
    mode: 0o700,
  });
  // Repair a stale child DACL before any overwrite or DPAPI work.
  hardenProgramDataAcl(p.root);
  await writeProtectedSecretFile(
    p.secret,
    'control-plane-service-token',
    serviceToken,
    {
      overwrite: true,
      scope: 'local-machine',
    },
  );

  const env: NodeJS.ProcessEnv = {
    ...sourceEnv,
    NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_DPAPI_FILE:
      p.secret,
  };
  delete env.NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_FILE;
  delete env.NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_PLATFORM_NAME;

  await fs.writeFile(
    p.launcher,
    buildHubBootLauncher({
      env,
      executable: rt.executable,
      args: rt.args,
      pidFile: p.pid,
    }),
    'utf8',
  );

  const rawPort =
    sourceEnv.NEXOWIRE_HTTP_PORT ?? '43110';
  const port = Number(rawPort);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error(
      'Existing Hub has an invalid HTTP port.',
    );
  }

  hardenProgramDataAcl(p.root);

  const envForTask = taskEnv(options);
  let switched = false;
  try {
    // The PowerShell transaction can modify the user task before a later
    // command fails, so rollback must be armed before the first mutation.
    switched = true;
    await runPowerShellJson<{ ok: true }>(
      [
        "$ErrorActionPreference='Stop'",
        '$boot=$env:NEXOWIRE_HUB_BOOT_TASK_NAME',
        '$user=$env:NEXOWIRE_HUB_TASK_NAME',
        '$launcher=$env:NEXOWIRE_HUB_BOOT_LAUNCHER',
        '$argument=\'-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "\' + $launcher.Replace(\'"\',\'""\') + \'"\'',
        "$action=New-ScheduledTaskAction -Execute 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -Argument $argument",
        '$trigger=New-ScheduledTaskTrigger -AtStartup',
        "$principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest",
        '$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew',
        "Register-ScheduledTask -TaskName $boot -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Nexowire pre-logon Hub' -Force|Out-Null",
        '$userTask=Get-ScheduledTask -TaskName $user -ErrorAction SilentlyContinue',
        'if($userTask){',
        '  Stop-ScheduledTask -TaskName $user -ErrorAction SilentlyContinue',
        '  Disable-ScheduledTask -TaskName $user | Out-Null',
        '}',
        'Start-Sleep -Milliseconds 500',
        'Start-ScheduledTask -TaskName $boot',
        '[pscustomobject]@{ok=$true}|ConvertTo-Json -Compress',
      ].join('\n'),
      envForTask,
    );
    await waitForBootHub(port, p.pid);
    await writeManifest(
      options,
      sourceSecretFile,
      port,
    );
    hardenProgramDataAcl(p.root);
    return await hubBootLifecycleStatus(options);
  } catch (error) {
    if (switched) {
      await runPowerShellJson<{ ok: true }>(
        [
          "$ErrorActionPreference='Stop'",
          '$boot=$env:NEXOWIRE_HUB_BOOT_TASK_NAME',
          '$user=$env:NEXOWIRE_HUB_TASK_NAME',
          'Stop-ScheduledTask -TaskName $boot -ErrorAction SilentlyContinue',
          'Unregister-ScheduledTask -TaskName $boot -Confirm:$false -ErrorAction SilentlyContinue',
          '$userTask=Get-ScheduledTask -TaskName $user -ErrorAction SilentlyContinue',
          'if($userTask){',
          '  Enable-ScheduledTask -TaskName $user | Out-Null',
          '  Start-ScheduledTask -TaskName $user',
          '}',
          '[pscustomobject]@{ok=$true}|ConvertTo-Json -Compress',
        ].join('\n'),
        envForTask,
      ).catch(() => undefined);
    }
    await fs.rm(p.root, {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    throw error;
  }
}

export async function uninstallHubBootLifecycle(
  options: HubBootLifecycleOptions = {},
): Promise<{
  removed: boolean;
  taskName: string;
  userHubRestored: boolean;
}> {
  assertElevated();
  const p = pathsFor(options);
  const result = await runPowerShellJson<{
    removed: boolean;
    userHubRestored: boolean;
  }>(
    [
      "$ErrorActionPreference='Stop'",
      '$boot=$env:NEXOWIRE_HUB_BOOT_TASK_NAME',
      '$user=$env:NEXOWIRE_HUB_TASK_NAME',
      '$bootTask=Get-ScheduledTask -TaskName $boot -ErrorAction SilentlyContinue',
      '$removed=$false',
      'if($bootTask){',
      '  Stop-ScheduledTask -TaskName $boot -ErrorAction SilentlyContinue',
      '  Unregister-ScheduledTask -TaskName $boot -Confirm:$false',
      '  $removed=$true',
      '}',
      '$restored=$false',
      '$userTask=Get-ScheduledTask -TaskName $user -ErrorAction SilentlyContinue',
      'if($userTask){',
      '  Enable-ScheduledTask -TaskName $user | Out-Null',
      '  Start-ScheduledTask -TaskName $user',
      '  $restored=$true',
      '}',
      '[pscustomobject]@{removed=$removed;userHubRestored=$restored}|ConvertTo-Json -Compress',
    ].join('\n'),
    taskEnv(options),
  );
  await fs.rm(p.root, {
    recursive: true,
    force: true,
  });
  return {
    removed: result.removed,
    taskName: bootTaskName(options),
    userHubRestored: result.userHubRestored,
  };
}

export async function runHubBootLifecycleCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const action = args[0] ?? 'boot-status';
  const options: HubBootLifecycleOptions = {
    env,
  };
  let result: unknown;
  switch (action) {
    case 'boot-install':
      result =
        await installHubBootLifecycle(options);
      break;
    case 'boot-status':
      result =
        await hubBootLifecycleStatus(options);
      break;
    case 'boot-uninstall':
      result =
        await uninstallHubBootLifecycle(options);
      break;
    default:
      throw new Error(
        'Usage: nexowire hub [boot-install|boot-status|boot-uninstall]',
      );
  }
  process.stdout.write(
    JSON.stringify(result, null, 2) + '\n',
  );
}
