import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {PRIVILEGED_NODE_INJECTION_ENV} from '../src/security/windows-privileged-runtime-trust.js';
import {
  buildPrivilegedBrokerLauncher,
  privilegedBrokerTaskStatus,
  privilegedBrokerStatusScript,
  PRIVILEGED_BROKER_TASK_RECOVERY_SETTINGS,
  BROKER_ROOT_TASK_PATH,
} from '../src/agent/privileged-broker-lifecycle.js';

test('Broker TaskPath root survives TypeScript template-string interpolation', () => {
  assert.equal(BROKER_ROOT_TASK_PATH, String.raw`'\'`);
  const source = readFileSync(new URL('../src/agent/privileged-broker-lifecycle.ts', import.meta.url), 'utf8');
  const interpolated = '-TaskPath ${BROKER_ROOT_TASK_PATH}';
  assert.equal(source.split(interpolated).length - 1, 7);
  assert.equal('-TaskPath ' + BROKER_ROOT_TASK_PATH, String.raw`-TaskPath '\'`);
});

test('Broker status preserves unsigned Windows HRESULT task results without Int32 overflow',
  {skip:process.platform!=='win32'},()=>{
    // Real PowerShell conversion/serialization; synthetic read-only task data.
    const script=`
function Get-ScheduledTask { [pscustomobject]@{State='Running'} }
function Get-ScheduledTaskInfo { [pscustomobject]@{
  LastRunTime=[datetime]::MinValue; NextRunTime=[datetime]::MinValue
  LastTaskResult=[uint32]2147946720
} }
${privilegedBrokerStatusScript}`;
    const result=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,
        timeout:30_000,env:{...process.env,NEXOWIRE_BROKER_TASK_NAME:'Synthetic Readonly Broker'}});
    assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(result.stdout.replace(/^\uFEFF/,'')).lastTaskResult,2147946720);
  });

test('broker task launcher preserves runtime args and never persists plaintext broker tokens', () => {
  const launcher = buildPrivilegedBrokerLauncher({
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    execArgv: ['--import', 'tsx'],
    cliEntrypoint: "C:\\Work\\Nexowire O'Brien\\src\\cli.ts",
    env: {
      NEXOWIRE_PRIVILEGED_BROKER_HOST: '127.0.0.1',
      NEXOWIRE_PRIVILEGED_BROKER_PORT: '43112',
      NEXOWIRE_PRIVILEGED_BROKER_SECRET_FILE:
        "C:\\Users\\User\\Nexowire O'Brien\\broker.dpapi.json",
      NEXOWIRE_PRIVILEGED_BROKER_TOKEN: 'must-not-persist',
      NEXOWIRE_PRIVILEGED_BROKER_TOKENS:
        'must-not-persist-either',
    },
  });

  assert.match(
    launcher,
    /'C:\\Program Files\\nodejs\\node\.exe'/,
  );
  assert.match(launcher, /'--import' 'tsx'/);
  assert.match(launcher, /'privileged-broker' 'run'/);
  assert.match(launcher, /O''Brien/);
  assert.equal(launcher.includes('must-not-persist'), false);
});

test('elevated Broker launcher strips account-level Node injection variables before executing code',()=>{
  const launcher=buildPrivilegedBrokerLauncher({
    execPath:'C:\\Program Files\\nodejs\\node.exe',
    execArgv:[],
    cliEntrypoint:'C:\\ProgramData\\Nexowire\\cli.js',
    env:{
      NODE_OPTIONS:'--require C:\\Users\\Public\\inject.js',
      NODE_PATH:'C:\\Users\\Public\\node_modules',
      NODE_EXTRA_CA_CERTS:'C:\\Users\\Public\\fake.pem',
    },
  });
  const command=launcher.indexOf("'C:\\Program Files\\nodejs\\node.exe'");
  assert.ok(command>0);
  for(const variable of PRIVILEGED_NODE_INJECTION_ENV){
    const clear='$env:'+variable+'=$null';
    assert.ok(launcher.includes(clear),variable);
    assert.ok(launcher.indexOf(clear)<command,variable);
    assert.ok(!launcher.includes('C:\\Users\\Public'),variable);
  }
});

test('elevated Broker installer rejects untrusted runtime before secrets, launcher or task registration',()=>{
  const source=readFileSync(
    new URL('../src/agent/privileged-broker-lifecycle.ts',import.meta.url),'utf8',
  );
  const begin=source.indexOf('export async function installPrivilegedBrokerTask');
  const end=source.indexOf('/** Fail closed before operating on an elevated scheduled task.');
  assert.ok(begin>=0 && end>begin);
  const installer=source.slice(begin,end);
  const boundary=[
    'assertNoPrivilegedNodeStartupFlags(options.execArgv??process.execArgv)',
    'assertWindowsPrivilegedRuntimeTrusted({',
    'await loadOrCreatePrivilegedBrokerToken({',
    'await fs.mkdir(directory,',
    'await fs.writeFile(',
    'Register-ScheduledTask -TaskName $name',
    'Start-ScheduledTask -TaskName $name',
  ];
  let previous=-1;
  for(const step of boundary){
    const next=installer.indexOf(step);
    assert.ok(next>previous,step);
    previous=next;
  }
  assert.match(installer,/const cliEntrypoint=options\.cliEntrypoint\?\?process\.argv\[1\]/);
  assert.match(installer,/\scliEntrypoint,\s/);
  assert.match(installer,/executable:options\.execPath\?\?process\.execPath/);
  assert.match(installer,/env,/);
});

test('Highest Broker install refuses custom task identities before secrets and registration',()=>{
  const source=readFileSync(
    new URL('../src/agent/privileged-broker-lifecycle.ts',import.meta.url),'utf8',
  );
  const begin=source.indexOf('export async function installPrivilegedBrokerTask');
  const end=source.indexOf('/** Fail closed before operating on an elevated scheduled task.',begin);
  const install=source.slice(begin,end);
  const restriction=install.indexOf('BROKER_INSTALL_NONCANONICAL_TASK_DENIED');
  const existing=install.indexOf('const existingTaskPreflight');
  const taskRead=install.indexOf("Get-ScheduledTask -TaskName $name -TaskPath");
  const verify=install.indexOf('privilegedBrokerTaskControlPreflightScript',existing);
  const preflight=install.indexOf('await runPowerShellJson<{ok:boolean}>');
  const secret=install.indexOf('await loadOrCreatePrivilegedBrokerToken');
  const launcherWrite=install.indexOf('await fs.writeFile(');
  const registration=install.indexOf('Register-ScheduledTask -TaskName $name');
  assert.ok(begin>=0 && end>begin);
  assert.ok(restriction>=0 && restriction<existing);
  assert.ok(existing<taskRead && taskRead<verify && verify<preflight);
  assert.ok(preflight<secret && secret<launcherWrite && launcherWrite<registration);
  assert.match(install,/Get-ScheduledTask -TaskName \$name -TaskPath/);
  assert.match(install,/Register-ScheduledTask -TaskName \$name -TaskPath/);
  assert.match(install,/Start-ScheduledTask -TaskName \$name -TaskPath/);
  // Existing identity is verified once before any secrets and again at registration.
  assert.ok(install.indexOf('privilegedBrokerTaskControlPreflightScript',verify+1)>preflight);
});

test('Highest Broker uninstall checks parent ACL before task mutation and after scheduler completion',()=>{
  const source=readFileSync(
    new URL('../src/agent/privileged-broker-lifecycle.ts',import.meta.url),'utf8',
  );
  const begin=source.indexOf('export async function uninstallPrivilegedBrokerTask');
  const end=source.indexOf('export interface PrivilegedBrokerHealthReport',begin);
  const uninstall=source.slice(begin,end);
  const canonical=uninstall.indexOf('BROKER_UNINSTALL_NONCANONICAL_TASK_DENIED');
  const parent=uninstall.indexOf('const protectedParent=path.win32.dirname(protectedRoot)');
  const firstAcl=uninstall.indexOf('verifyWindowsPrivateAcl(protectedParent)');
  const firstTree=uninstall.indexOf('await assertBrokerRootSafeToRemove(protectedRoot)');
  const task=uninstall.indexOf('await runPowerShellJson<{ removed: boolean }>');
  const lastAcl=uninstall.indexOf('verifyWindowsPrivateAcl(protectedParent)',firstAcl+1);
  const lastTree=uninstall.indexOf('await assertBrokerRootSafeToRemove(protectedRoot)',firstTree+1);
  const remove=uninstall.indexOf('await fs.rm(protectedRoot');
  assert.ok(canonical>=0 && canonical<parent && parent<firstAcl);
  assert.ok(firstAcl<firstTree && firstTree<task);
  assert.ok(task<lastAcl && lastAcl<lastTree && lastTree<remove);
});

test('Highest Broker uninstaller verifies canonical task before stopping or removal',()=>{
  const source=readFileSync(
    new URL('../src/agent/privileged-broker-lifecycle.ts',import.meta.url),'utf8',
  );
  const begin=source.indexOf('export async function uninstallPrivilegedBrokerTask');
  const end=source.indexOf('export interface PrivilegedBrokerHealthReport',begin);
  const uninstall=source.slice(begin,end);
  const restriction=uninstall.indexOf('BROKER_UNINSTALL_NONCANONICAL_TASK_DENIED');
  const task=uninstall.indexOf('Get-ScheduledTask -TaskName $name -TaskPath');
  const check=uninstall.indexOf('privilegedBrokerTaskControlPreflightScript');
  const stop=uninstall.indexOf('Stop-ScheduledTask -TaskName $name -TaskPath');
  const unregister=uninstall.indexOf('Unregister-ScheduledTask -TaskName $name -TaskPath');
  const deleteFiles=uninstall.indexOf('await fs.rm(protectedRoot');
  assert.ok(restriction>=0 && restriction<task);
  assert.ok(task<check && check<stop && stop<unregister && unregister<deleteFiles);
  assert.match(uninstall,/await assertBrokerRootSafeToRemove\(protectedRoot\)/);
});

test(
  'broker task status is Windows-only',
  { skip: process.platform === 'win32' },
  async () => {
    await assert.rejects(
      () =>
        privilegedBrokerTaskStatus({
          taskName: 'Nexowire Test Broker',
        }),
      /only on Windows/i,
    );
  },
);

test('elevated broker task has unattended crash/recovery policy without system elevation', () => {
  const script = PRIVILEGED_BROKER_TASK_RECOVERY_SETTINGS;
  assert.match(script, /New-ScheduledTaskSettingsSet/);
  assert.match(script, /-RestartCount 999/);
  assert.match(script, /-RestartInterval \(New-TimeSpan -Minutes 1\)/);
  assert.match(script, /-ExecutionTimeLimit \(New-TimeSpan -Seconds 0\)/);
  assert.match(script, /-StartWhenAvailable/);
  assert.match(script, /-MultipleInstances IgnoreNew/);
  assert.match(script, /-AllowStartIfOnBatteries/);
  assert.match(script, /-DontStopIfGoingOnBatteries/);
  assert.match(script, /New-ScheduledTaskTrigger -Once/);
  assert.match(script, /-RepetitionInterval \(New-TimeSpan -Minutes 1\)/);
  assert.match(script, /\$minuteTrigger\.Repetition\.Duration=\$null/);
  assert.match(script, /\$minuteTrigger\.Repetition\.StopAtDurationEnd=\$false/);
  assert.doesNotMatch(script, /-UserId|SYSTEM|ServiceAccount/);
});
