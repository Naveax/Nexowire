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
    ].join('\\n');
    const run=spawnSync(powershell,[
      '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(script,'utf16le').toString('base64'),
    ],{encoding:'utf8',timeout:15000,windowsHide:true});
    assert.equal(run.status===0,scenario.accepted,scenario.name+': '+(run.stderr||run.stdout));
    if(scenario.accepted)assert.match(run.stdout,/GUARD_ACCEPTED/);
    else assert.match(run.stderr+run.stdout,/HUB_BOOT_TASK_IDENTITY_MISMATCH/);
  }
});
