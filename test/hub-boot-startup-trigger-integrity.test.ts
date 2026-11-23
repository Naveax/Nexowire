import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {
  assertProtectedHubBootLauncherContext,
  buildHubBootLauncher,
  hubBootRegisteredTaskIdentityGuard,
} from '../src/hub/hub-boot-lifecycle.js';

const protectedState=String.raw`C:\ProgramData\Nexowire\hub-state`;
const secret=String.raw`C:\ProgramData\Nexowire\hub-boot\control-plane-service-token.machine.dpapi.json`;
const pid=String.raw`C:\ProgramData\Nexowire\hub-boot\hub.pid`;
const safeEnv={
  NEXOWIRE_STATE_DIR:protectedState,
  NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_DPAPI_FILE:secret,
  NEXOWIRE_HTTP_HOST:'127.0.0.1',
};

test('standalone SYSTEM launcher refuses to persist legacy user state or credential references',()=>{
  assert.doesNotThrow(()=>assertProtectedHubBootLauncherContext(safeEnv,pid));
  for(const env of [
    {...safeEnv,NEXOWIRE_STATE_DIR:String.raw`C:\Users\Owner\.nexowire\hub`},
    {...safeEnv,NEXOWIRE_STATE_DIR:String.raw`C:\ProgramData\Nexowire\hub-state\..\other`},
    {...safeEnv,NEXOWIRE_STATE_DIR:undefined},
  ]){
    assert.throws(()=>assertProtectedHubBootLauncherContext(env,pid),
      /HUB_BOOT_SYSTEM_STATE_MIGRATION_REQUIRED/);
  }
  for(const [env,pidFile] of [
    [{...safeEnv,NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_DPAPI_FILE:String.raw`C:\Users\Owner\.nexowire\secrets\token.dpapi.json`},pid],
    [{...safeEnv,NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_DPAPI_FILE:secret.toLowerCase()},pid],
    [{...safeEnv,NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_FILE:'C:\\secrets\\plaintext'},pid],
    [{...safeEnv,NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_PLATFORM_NAME:'legacy-store'},pid],
    [safeEnv,String.raw`C:\Users\Owner\hub.pid`],
  ] as const){
    assert.throws(()=>assertProtectedHubBootLauncherContext(env,pidFile),
      /HUB_BOOT_UNPROTECTED_LAUNCHER_CONTEXT/);
  }
  assert.throws(()=>buildHubBootLauncher({
    env:{...safeEnv,NEXOWIRE_STATE_DIR:String.raw`C:\Users\Owner\.nexowire\hub`},
    executable:'node.exe',args:['cli.js','http'],pidFile:pid,
  }),/HUB_BOOT_SYSTEM_STATE_MIGRATION_REQUIRED/);
  assert.match(buildHubBootLauncher({
    env:safeEnv,executable:'node.exe',args:['cli.js','http'],pidFile:pid,
  }),/NEXOWIRE_STATE_DIR/);
});

test('boot identity guard explicitly pins one enabled AtStartup trigger and an empty action working directory',()=>{
  const source=readFileSync(new URL('../src/hub/hub-boot-lifecycle.ts',import.meta.url),'utf8');
  assert.match(hubBootRegisteredTaskIdentityGuard,/MSFT_TaskBootTrigger/);
  assert.match(hubBootRegisteredTaskIdentityGuard,/\$bootTriggers\.Count -eq 1/);
  assert.match(hubBootRegisteredTaskIdentityGuard,/\$bootTriggers\[0\]\.Enabled/);
  assert.match(hubBootRegisteredTaskIdentityGuard,/\$bootActions\[0\]\.WorkingDirectory/);
  const begin=source.indexOf('export async function installHubBootLifecycle(');
  const gate=source.indexOf('hubBootRegisteredTaskIdentityGuard',begin);
  const register=source.indexOf('Register-ScheduledTask -TaskName $boot',begin);
  assert.ok(gate>begin && register>gate,'identity gate must precede task registration');
});

test('PowerShell rejects logon-only, duplicate, disabled startup and hijacked working directory task identities',{
  skip:process.platform!=='win32',
},()=>{
  const powershell=String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
  const scenarios=[
    {name:'canonical startup',change:'',accepted:true},
    {name:'no trigger',change:'$bootTask.Triggers=@()',accepted:false},
    {name:'logon trigger',change:"$bootTask.Triggers[0].CimClass.CimClassName='MSFT_TaskLogonTrigger'",accepted:false},
    {name:'disabled trigger',change:'$bootTask.Triggers[0].Enabled=$false',accepted:false},
    {name:'duplicate trigger',change:'$bootTask.Triggers=@($bootTask.Triggers[0],$bootTask.Triggers[0])',accepted:false},
    {name:'hijacked working directory',change:"$bootTask.Actions[0].WorkingDirectory='C:\\Users\\Owner\\Downloads'",accepted:false},
    {name:'wrong principal',change:"$bootTask.Principal.UserId='S-1-5-19'",accepted:false},
  ] as const;
  for(const scenario of scenarios){
    const script=[
      "$ErrorActionPreference='Stop'",
      "$boot='Nexowire Hub Boot'",
      "$user='Nexowire Hub'",
      "$env:NEXOWIRE_HUB_BOOT_LAUNCHER='C:\\ProgramData\\Nexowire\\hub-boot\\launch.ps1'",
      "$env:NEXOWIRE_HUB_USER_LAUNCHER='C:\\Users\\Owner\\.nexowire\\hub-service\\launch.ps1'",
      "$exe='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
      "$args='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"' + $env:NEXOWIRE_HUB_BOOT_LAUNCHER + '\"'",
      "$bootTask=[pscustomobject]@{TaskPath='\\';TaskName=$boot;Actions=@([pscustomobject]@{Execute=$exe;Arguments=$args;WorkingDirectory=''});Triggers=@([pscustomobject]@{CimClass=[pscustomobject]@{CimClassName='MSFT_TaskBootTrigger'};Enabled=$true});Principal=[pscustomobject]@{UserId='S-1-5-18';LogonType='ServiceAccount';RunLevel='Highest'}}",
      '$userTask=$null',
      scenario.change,
      hubBootRegisteredTaskIdentityGuard,
      "'GUARD_ACCEPTED'",
    ].join('\n');
    const run=spawnSync(powershell,[
      '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(script,'utf16le').toString('base64'),
    ],{encoding:'utf8',timeout:15000,windowsHide:true});
    assert.equal(run.status===0,scenario.accepted,scenario.name+': '+(run.stderr||run.stdout));
    if(scenario.accepted)assert.match(run.stdout,/GUARD_ACCEPTED/);
    else assert.match(run.stderr+run.stdout,/HUB_BOOT_TASK_IDENTITY_MISMATCH/);
  }
});

test('AtStartup launcher isolates PowerShell lookup and rejects inherited writable skills catalogs',()=>{
  const override=String.raw`C:\Users\Owner\.nexowire\skills`;
  assert.throws(()=>assertProtectedHubBootLauncherContext({
    ...safeEnv,
    NEXOWIRE_SKILLS_DIR:override,
  },pid),/HUB_BOOT_UNPROTECTED_LAUNCHER_CONTEXT/);

  const launcher=buildHubBootLauncher({
    env:safeEnv,executable:'node.exe',args:['cli.js','http'],pidFile:pid,
  });
  const modules=launcher.indexOf("$env:PSModulePath='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'");
  const pathVar=launcher.indexOf("$env:PATH='C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0'");
  const scrub=launcher.indexOf('Remove-Item -Path Env:NEXOWIRE_SKILLS_DIR -ErrorAction SilentlyContinue');
  const spawn=launcher.indexOf('Start-Process -FilePath');
  assert.ok(modules>=0 && pathVar>=0 && scrub>=0 &&
    modules<scrub && pathVar<scrub && scrub<spawn,
    'Clean bootstrap must precede all privileged child startup');
  assert.equal(launcher.includes('$env:NEXOWIRE_SKILLS_DIR='),false);

  const source=readFileSync(new URL('../src/hub/hub-boot-lifecycle.ts',import.meta.url),'utf8');
  const install=source.slice(source.indexOf('export async function installHubBootLifecycle('));
  const sanitize=install.indexOf('delete env.NEXOWIRE_SKILLS_DIR;');
  const build=install.indexOf('buildHubBootLauncher({');
  assert.ok(sanitize>=0 && build>sanitize,
    'Interactive skills overrides must be removed before creating the SYSTEM launcher');
});

test('SYSTEM launcher clears machine-scoped Nexowire variables before its explicit allowlist',()=>{
  const launcher=buildHubBootLauncher({
    env:safeEnv,executable:'node.exe',args:['cli.js','http'],pidFile:pid,
  });
  const ambientScrub=launcher.indexOf("Get-ChildItem Env: | Where-Object { $_.Name -like 'NEXOWIRE_*' }");
  const stateAssign=launcher.indexOf('$env:NEXOWIRE_STATE_DIR=');
  const machineSecretAssign=launcher.indexOf('$env:NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_DPAPI_FILE=');
  const start=launcher.indexOf('Start-Process -FilePath');
  assert.ok(ambientScrub>=0 &&
    ambientScrub<stateAssign && ambientScrub<machineSecretAssign &&
    stateAssign<start && machineSecretAssign<start,
    'Ambient Nexowire variables must be cleared before any pinned SYSTEM env assignments');
  assert.doesNotMatch(launcher,/\$env:NEXOWIRE_MCP_BEARER_TOKEN=/);
  assert.doesNotMatch(launcher,/\$env:NEXOWIRE_MCP_BEARER_TOKENS=/);
});

test('PowerShell startup scrub removes synthetic machine Nexowire secrets without losing pinned SYSTEM state',{
  skip:process.platform!=='win32',
},()=>{
  const launcher=buildHubBootLauncher({
    env:safeEnv,executable:'node.exe',args:['cli.js','http'],pidFile:pid,
  });
  const lines=launcher.split('\r\n');
  const scrub=lines.find(line=>line.startsWith('Get-ChildItem Env: | Where-Object'));
  const pinnedState=lines.find(line=>line.startsWith('$env:NEXOWIRE_STATE_DIR='));
  const pinnedSecret=lines.find(line=>line.startsWith('$env:NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_DPAPI_FILE='));
  assert.ok(scrub&&pinnedState&&pinnedSecret);
  const script=[
    "$ErrorActionPreference='Stop'",
    "$env:NEXOWIRE_MCP_BEARER_TOKEN='synthetic-never-real'",
    "$env:NEXOWIRE_MCP_BEARER_TOKENS='synthetic-only'",
    "$env:NEXOWIRE_HTTP_HOST='untrusted-host'",
    scrub,pinnedState,pinnedSecret,
    "if(Test-Path Env:NEXOWIRE_MCP_BEARER_TOKEN){throw 'NEXOWIRE_MACHINE_SECRET_INHERITED'}",
    "if(Test-Path Env:NEXOWIRE_MCP_BEARER_TOKENS){throw 'NEXOWIRE_MACHINE_SECRET_INHERITED'}",
    "if(Test-Path Env:NEXOWIRE_HTTP_HOST){throw 'NEXOWIRE_MACHINE_ENDPOINT_INHERITED'}",
    "if($env:NEXOWIRE_STATE_DIR -cne 'C:\\ProgramData\\Nexowire\\hub-state'){throw 'SYSTEM_STATE_LOST'}",
    "if($env:NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN_DPAPI_FILE -cne 'C:\\ProgramData\\Nexowire\\hub-boot\\control-plane-service-token.machine.dpapi.json'){throw 'SYSTEM_SECRET_PATH_LOST'}",
    "'NEXOWIRE_SYSTEM_STARTUP_ENV_PASS'",
  ].join('\n');
  const powershell=String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
  const child=spawnSync(powershell,[
    '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
    Buffer.from(script,'utf16le').toString('base64'),
  ],{encoding:'utf8',timeout:15000,windowsHide:true});
  assert.equal(child.status,0,child.stderr||child.stdout);
  assert.match(child.stdout,/NEXOWIRE_SYSTEM_STARTUP_ENV_PASS/);
});
