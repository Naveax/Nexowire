import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {systemHubRecoveryTaskAbsencePreflightScript} from
  '../scripts/ai04-controlled-system-hub-cutover.js';

const preflight=systemHubRecoveryTaskAbsencePreflightScript();
const powershell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const source=readFileSync(path.resolve('scripts/ai04-controlled-system-hub-cutover.ts'),'utf8');

test('AI04 requires independent COM absence before any recovery artifact and again before task registration',()=>{
  const arm=source.indexOf('async armRecovery(){');
  const initial=source.indexOf('runPS(systemHubRecoveryTaskAbsencePreflightScript())',arm);
  const mkdir=source.indexOf('await fs.mkdir(ROOT',arm);
  const second=source.indexOf('runPS(systemHubRecoveryTaskAbsencePreflightScript())',initial+1);
  const register=source.indexOf('Register-ScheduledTask -TaskName',second);
  assert.ok(arm>=0&&initial>arm&&mkdir>initial&&second>mkdir&&register>second,
    'recovery task absence must be independently proven before artifacts and registration');
  assert.doesNotMatch(source.slice(second,register),
    /Get-ScheduledTask.*SilentlyContinue/);
  assert.match(preflight,/Get-ScheduledTask.*-ErrorAction Stop/);
  assert.match(preflight,/GetTask\('Nexowire Hub Cutover Recovery'\)/);
  assert.match(preflight,/-2147024894/);
  assert.doesNotMatch(preflight,
    /Register-ScheduledTask|Unregister-ScheduledTask|Stop-ScheduledTask|Start-ScheduledTask|Disable-ScheduledTask/);
});

type Mode='cmdlet-present'|'absent'|'cmdlet-null'|'com-present'|'com-denied'|
  'com-null'|'com-fault'|'service-fault';
function checkFixture(mode:Mode):string{
  const code64=Buffer.from(preflight,'utf8').toString('base64');
  const script=[
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    "$script:mode='"+mode+"'",
    '$script:folder=[pscustomobject]@{}',
    '$script:folder|Add-Member -MemberType ScriptMethod -Name GetTask -Value {',
    '  param([string]$name)',
    "  if($script:mode -in @('absent','cmdlet-null')){throw ([Runtime.InteropServices.COMException]::new('not-found',-2147024894))}",
    "  if($script:mode -eq 'com-denied'){throw ([Runtime.InteropServices.COMException]::new('denied',-2147024891))}",
    "  if($script:mode -eq 'com-null'){return $null}",
    "  if($script:mode -eq 'com-fault'){throw 'SYNTHETIC_UNKNOWN_COM_ERROR'}",
    '  return [pscustomobject]@{Name=$name}',
    '}',
    '$script:svc=[pscustomobject]@{}',
    '$script:svc|Add-Member -MemberType ScriptMethod -Name Connect -Value {return}',
    '$script:svc|Add-Member -MemberType ScriptMethod -Name GetFolder -Value {param([string]$path);return $script:folder}',
    'function New-Object {',
    '  [CmdletBinding()]param([string]$ComObject)',
    "  if($script:mode -eq 'service-fault'){throw 'SYNTHETIC_COM_CONNECTION_FAILED'}",
    "  if($ComObject -cne 'Schedule.Service'){throw 'UNEXPECTED_COM_CLASS'}",
    '  return $script:svc',
    '}',
    'function Get-ScheduledTask {',
    '  [CmdletBinding()]param([string]$TaskName,[string]$TaskPath)',
    "  if($script:mode -eq 'cmdlet-present'){return [pscustomobject]@{Name=$TaskName}}",
    "  if($script:mode -eq 'cmdlet-null'){return $null}",
    "  throw 'SYNTHETIC_SCHEDULER_CMDLET_INACCESSIBLE'",
    '}',
    "$code=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+code64+"'))",
    "try{&([scriptblock]::Create($code))}catch{'DENY:'+$_.Exception.Message}",
  ].join('\r\n');
  const run=spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive',
    '-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
  {windowsHide:true,encoding:'utf8',timeout:15000,maxBuffer:128*1024});
  assert.equal(run.status,0,run.stderr);
  return run.stdout.trim();
}
for(const [mode,expected] of [
  ['cmdlet-present','DENY:AI04_RECOVERY_TASK_ALREADY_EXISTS'],
  ['absent','OK'],
  ['cmdlet-null','OK'],
  ['com-present','DENY:AI04_RECOVERY_TASK_STILL_REGISTERED_OR_HIDDEN'],
  ['com-denied','DENY:AI04_RECOVERY_TASK_VISIBILITY_UNVERIFIED'],
  ['com-null','DENY:AI04_RECOVERY_TASK_STILL_REGISTERED_OR_HIDDEN'],
  ['com-fault','DENY:AI04_RECOVERY_TASK_VISIBILITY_UNVERIFIED'],
  ['service-fault','DENY:SYNTHETIC_COM_CONNECTION_FAILED'],
] as const){
  test('AI04 recovery registration absence '+mode,{skip:process.platform!=='win32'},()=>{
    assert.equal(checkFixture(mode),expected);
  });
}