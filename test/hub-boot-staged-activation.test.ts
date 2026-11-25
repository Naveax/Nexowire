import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {
  assessWindowsUnattendedRebootReadiness,
  hubBootStartupSettingsProbe,hubBootStagedActivationGuard,
  hubBootUserTaskVisibilityProbe,hubBootUserTaskAbsenceGuard,
} from '../src/hub/hub-boot-lifecycle.js';

const source=readFileSync(new URL('../src/hub/hub-boot-lifecycle.ts',import.meta.url),'utf8');
const install=source.slice(source.indexOf('export async function installHubBootLifecycle('),
  source.indexOf('export async function uninstallHubBootLifecycle('));
const win=process.platform==='win32';
const powershell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function runPS(script:string):string{
  // Only in-memory constructors, synthetic objects and read-only conditionals.
  // Never register, enable, stop, start or unregister a real scheduled task.
  assert.doesNotMatch(script,/(?:Get|Register|Unregister|Enable|Disable|Start|Stop)-ScheduledTask\b/);
  const r=spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
    Buffer.from(script,'utf16le').toString('base64')],{
    encoding:'utf8',windowsHide:true,timeout:15000,
  });
  assert.equal(r.status,0,r.stderr||r.stdout);
  return r.stdout.trim();
}

test('SYSTEM task is registered disabled and activation is witnessed before Enable after verified handoff',()=>{
  const settings=install.indexOf('New-ScheduledTaskSettingsSet -Disable -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries');
  const register=install.indexOf('Register-ScheduledTask -TaskName $boot',settings);
  const staged=install.indexOf('hubBootStagedActivationGuard',register);
  const stopUser=install.indexOf('Stop-ScheduledTask -TaskName $user',staged);
  const drain=install.indexOf('HUB_LEGACY_PORT_STILL_OWNED',stopUser);
  const recheck=install.indexOf('hubBootStagedActivationGuard',drain);
  const legacy=install.indexOf('$quiescedLegacyState',recheck);
  const witness=install.indexOf('"$systemStartAttempted=$true"',legacy);
  const enable=install.indexOf('Enable-ScheduledTask -TaskName $boot',witness);
  const activated=install.indexOf('HUB_BOOT_ACTIVATION_UNVERIFIED',enable);
  const postLegacy=install.indexOf('$quiescedLegacyState',activated);
  const start=install.indexOf('Start-ScheduledTask -TaskName $boot',postLegacy);
  const order=[settings,register,staged,stopUser,drain,recheck,legacy,witness,enable,activated,postLegacy,start];
  assert.ok(order.every((v,i)=>v>=0&&(i===0||v>order[i-1]!)),String(order));
  const rollback=install.slice(install.indexOf('let taskRollbackFailure'));
  assert.ok(rollback.indexOf('hubBootStagedActivationGuard')>=0);
  assert.ok(rollback.indexOf('hubBootStagedActivationGuard')<rollback.indexOf('Unregister-ScheduledTask -TaskName $boot'));
  assert.match(install,/\} catch \{ \$systemStartAttempted = \$true; throw \}/);
});

test('all handoff task snapshots reject an ACL-hidden or unverified legacy task',()=>{
  const lookups=[...install.matchAll(/\$userTask=Get-ScheduledTask -TaskName \$user[^\n]*\n/g)];
  assert.equal(lookups.length,6);
  for(const lookup of lookups){
    const suffix=install.slice(lookup.index!+lookup[0].length);
    const probe=suffix.indexOf('hubBootUserTaskVisibilityProbe');
    const guard=suffix.indexOf('hubBootUserTaskAbsenceGuard');
    const identity=suffix.indexOf('hubBootRegisteredTaskIdentityGuard');
    assert.ok(probe>=0&&probe<guard&&guard<identity);
    assert.doesNotMatch(suffix.slice(0,identity),/ScheduledTask -TaskName/);
  }
});

test('real Windows task settings constructor stages disabled startup without battery or idle restrictions',{
  skip:!win,
},()=>{
  const line=install.split('\n').find(l=>l.trim().startsWith("'$settings=New-ScheduledTaskSettingsSet"));
  assert.ok(line);
  const settings=line.trim().slice(1,-2);
  const receipt=JSON.parse(runPS([
    "$ErrorActionPreference='Stop'",settings,
    '$trigger=New-ScheduledTaskTrigger -AtStartup',
    "$bootTask=[pscustomobject]@{Settings=$settings;State='Disabled'}",
    hubBootStartupSettingsProbe,hubBootStagedActivationGuard,
    '[pscustomobject]@{safe=$bootStartupSettingsSafe;enabled=$bootStartupEnabled;triggerEnabled=$trigger.Enabled;triggerClass=$trigger.CimClass.CimClassName}|ConvertTo-Json -Compress',
  ].join('\n')));
  assert.deepEqual(receipt,{safe:true,enabled:false,triggerEnabled:true,triggerClass:'MSFT_TaskBootTrigger'});
});

test('Windows staged activation rejects ambiguous settings and premature activation',{
  skip:!win,
},()=>{
  const cases=[
    {change:'',staged:true,enabled:false},
    {change:"$bootTask.State='Ready';$bootTask.Settings.Enabled=$true",staged:false,enabled:true},
    {change:"$bootTask.State='Running';$bootTask.Settings.Enabled=$true",staged:false,enabled:true},
    {change:"$bootTask.State='Disabled';$bootTask.Settings.Enabled=$true",staged:false,enabled:false},
    {change:"$bootTask.State='Ready'",staged:false,enabled:false},
    {change:"$bootTask.Settings.Enabled='false'",staged:false,enabled:false},
    {change:"$bootTask.Settings.StopIfGoingOnBatteries=$true",staged:false,enabled:false},
    {change:"$bootTask.Settings.DisallowStartIfOnBatteries=$true",staged:false,enabled:false},
    {change:"$bootTask.Settings.RunOnlyIfIdle=$true",staged:false,enabled:false},
    {change:"$bootTask.Settings=$null",staged:false,enabled:false},
    {change:"$bootTask=$null",staged:false,enabled:false},
  ];
  // Keep each EncodedCommand below Windows' process command-line limit.
  for(const c of cases){
    const out=runPS([
      "$ErrorActionPreference='Stop'",
      "$bootTask=[pscustomobject]@{State='Disabled';Settings=[pscustomobject]@{Enabled=$false;DisallowStartIfOnBatteries=$false;StopIfGoingOnBatteries=$false;RunOnlyIfIdle=$false}}",
      c.change,hubBootStartupSettingsProbe,"$staged=$false",
      'try {',hubBootStagedActivationGuard,'$staged=$true',"}catch{if($_.Exception.Message -cne 'HUB_BOOT_STAGED_ACTIVATION_UNVERIFIED'){throw}}",
      '[pscustomobject]@{staged=$staged;enabled=$bootStartupEnabled}|ConvertTo-Json -Compress',
    ].join('\n'));
    assert.deepEqual(JSON.parse(out),{staged:c.staged,enabled:c.enabled},c.change);
  }
});

test('Windows legacy visibility gate permits only observed task or verified COM absence',{
  skip:!win,
},()=>{
  const scenarios=[
    {hresult:-2147024894,visible:false,allowed:true},
    {hresult:-2147024891,visible:false,allowed:false},
    {hresult:-2147467259,visible:false,allowed:false},
    {hresult:-2147024891,visible:true,allowed:true},
  ];
  for(const c of scenarios){
    const mock=hubBootUserTaskVisibilityProbe.replace(
      "    $scheduleService=New-Object -ComObject 'Schedule.Service' -ErrorAction Stop",
      "    throw ([System.Runtime.InteropServices.COMException]::new('fixture',"+c.hresult+"))",
    );
    assert.notEqual(mock,hubBootUserTaskVisibilityProbe);
    assert.match(mock,/GetTask\(\$user\)/);
    const result=runPS([
      "$ErrorActionPreference='Stop'","$user='Synthetic User Task'",
      c.visible?"$userTask=[pscustomobject]@{State='Disabled'}":"$userTask=$null",
      mock,'try {',hubBootUserTaskAbsenceGuard,"'ALLOWED'",
      "}catch{if($_.Exception.Message -cne 'HUB_USER_TASK_VISIBILITY_UNVERIFIED'){throw};'DENIED'}",
    ].join('\n'));
    assert.equal(result,c.allowed?'ALLOWED':'DENIED');
  }
});

test('reboot topology needs explicit enabled-state evidence and never implies remote acceptance',()=>{
  const valid={
    systemHubInstalled:true,systemHubTaskState:'ready',systemHubStartupEnabled:true,
    agent:{installed:true,systemIdentity:true,bootTrigger:true,interactiveOnly:false,taskEnabled:true},
    autoAdminLogon:false,
  };
  assert.equal(assessWindowsUnattendedRebootReadiness(valid).startupTopologyReady,true);
  for(const invalid of [
    {...valid,systemHubTaskState:'disabled'},
    {...valid,systemHubTaskState:undefined},
    {...valid,systemHubStartupEnabled:false},
    {...valid,systemHubStartupEnabled:undefined},
    {...valid,agent:{...valid.agent,taskEnabled:false}},
    {...valid,agent:{...valid.agent,taskEnabled:undefined}},
    {...valid,agent:{...valid.agent,bootTrigger:false}},
  ]){
    const result=assessWindowsUnattendedRebootReadiness(invalid);
    assert.equal(result.startupTopologyReady,false);
    assert.equal(result.remoteRebootAccepted,false);
  }
  assert.equal(assessWindowsUnattendedRebootReadiness(valid).remoteRebootAccepted,false);
  assert.match(source,/\$_\.Enabled -is \[bool\]/);
});
