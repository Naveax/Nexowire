import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {
  SYSTEM_HUB_RECOVERY_BOOT_VISIBILITY_PS,
  SYSTEM_HUB_RECOVERY_PS,
} from '../scripts/ai04-controlled-system-hub-cutover.js';

const powershell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
type Mode='found'|'absent'|'denied'|'still-hidden'|'null'|'cmdlet-null'|'service-fault';

test('recovery determines SYSTEM boot presence before state inspection or task mutation',()=>{
  const all=SYSTEM_HUB_RECOVERY_PS;
  const lookup=all.indexOf(SYSTEM_HUB_RECOVERY_BOOT_VISIBILITY_PS);
  const validate=all.indexOf('if($boot){',lookup);
  const stop=all.indexOf('Stop-ScheduledTask');
  assert.ok(lookup>0&&lookup<validate&&validate<stop,
    'Task Scheduler visibility must precede any recovery side effect');
  assert.match(SYSTEM_HUB_RECOVERY_BOOT_VISIBILITY_PS,/Get-ScheduledTask.*-ErrorAction Stop/);
  assert.match(SYSTEM_HUB_RECOVERY_BOOT_VISIBILITY_PS,/GetTask\('Nexowire Hub Boot'\)/);
  assert.match(SYSTEM_HUB_RECOVERY_BOOT_VISIBILITY_PS,/-2147024894/);
  assert.doesNotMatch(SYSTEM_HUB_RECOVERY_BOOT_VISIBILITY_PS,
    /Stop-ScheduledTask|Unregister-ScheduledTask|Enable-ScheduledTask|Start-ScheduledTask|SilentlyContinue/);
});

function runFixture(mode:Mode):string{
  const script=[
    "$ErrorActionPreference='Stop'",
    "$script:mode='"+mode+"'",
    '$script:folder=[pscustomobject]@{}',
    '$script:folder|Add-Member -MemberType ScriptMethod -Name GetTask -Value {',
    '  param([string]$taskName)',
    "  if($script:mode -eq 'absent'){throw ([System.Runtime.InteropServices.COMException]::new('not-found',-2147024894))}",
    "  if($script:mode -eq 'denied'){throw ([System.Runtime.InteropServices.COMException]::new('access-denied',-2147024891))}",
    "  if($script:mode -eq 'null'){return $null}",
    "  return [pscustomobject]@{Name=$taskName}",
    '}',
    '$script:svc=[pscustomobject]@{}',
    '$script:svc|Add-Member -MemberType ScriptMethod -Name Connect -Value { return }',
    '$script:svc|Add-Member -MemberType ScriptMethod -Name GetFolder -Value {param([string]$path);return $script:folder}',
    'function New-Object {',
    '  [CmdletBinding()]param([string]$ComObject)',
    "  if($script:mode -eq 'service-fault'){throw 'SYNTHETIC_COM_CONNECT_FAILED'}",
    "  if($ComObject -cne 'Schedule.Service'){throw 'UNEXPECTED_COM_SERVICE'}",
    '  return $script:svc',
    '}',
    'function Get-ScheduledTask {',
    '  [CmdletBinding()]param([string]$TaskName,[string]$TaskPath)',
    "  if($script:mode -eq 'found'){return [pscustomobject]@{Name=$TaskName}}",
    "  if($script:mode -eq 'cmdlet-null'){return $null}",
    "  throw 'SYNTHETIC_TASK_CMDLET_NOT_READABLE'",
    '}',
    "$code=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+
      Buffer.from(SYSTEM_HUB_RECOVERY_BOOT_VISIBILITY_PS,'utf8').toString('base64')+"'))",
    "try{&([scriptblock]::Create($code));'ACCEPT'}catch{'DENY:'+$_.Exception.Message}",
  ].join('\r\n');
  const result=spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive',
    '-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{
    windowsHide:true,encoding:'utf8',timeout:15000,maxBuffer:256*1024,
  });
  assert.equal(result.status,0,result.stderr);
  return result.stdout.trim();
}
for(const [mode,expected] of [
  ['found','ACCEPT'],
  ['absent','ACCEPT'],
  ['denied','DENY:AI04_RECOVERY_BOOT_VISIBILITY_UNVERIFIED'],
  ['still-hidden','DENY:AI04_RECOVERY_BOOT_STILL_REGISTERED_OR_HIDDEN'],
  ['null','DENY:AI04_RECOVERY_BOOT_STILL_REGISTERED_OR_HIDDEN'],
  ['cmdlet-null','DENY:AI04_RECOVERY_BOOT_STILL_REGISTERED_OR_HIDDEN'],
  ['service-fault','DENY:SYNTHETIC_COM_CONNECT_FAILED'],
] as const){
  test('recovery Task Scheduler visibility '+mode,{skip:process.platform!=='win32'},()=>{
    assert.equal(runFixture(mode),expected);
  });
}