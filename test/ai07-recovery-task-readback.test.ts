import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {systemHubRecoveryTaskReadbackScript} from '../scripts/ai04-controlled-system-hub-cutover.js';

const script=systemHubRecoveryTaskReadbackScript();

test('recovery task acceptance is a read-only identity, action and trigger readback',()=>{
  assert.match(script,/Get-ScheduledTask.*-ErrorAction Stop/);
  for(const expected of [
    'AI04_RECOVERY_TASK_IDENTITY_CHANGED',
    'AI04_RECOVERY_TASK_PRINCIPAL_UNTRUSTED',
    'AI04_RECOVERY_TASK_ACTION_UNTRUSTED',
    'AI04_RECOVERY_TASK_TRIGGERS_UNTRUSTED',
    'AI04_RECOVERY_TASK_RECURRENCE_UNTRUSTED',
    'AI04_RECOVERY_TASK_SINGLETON_UNTRUSTED',
    'AI04_RECOVERY_TASK_SETTINGS_UNTRUSTED',
  ])assert.ok(script.includes(expected),expected);
  assert.doesNotMatch(script,/Register-ScheduledTask|Unregister-ScheduledTask|Stop-ScheduledTask|Disable-ScheduledTask|Set-ScheduledTask/);
});

const healthyTask={
  TaskName:'Nexowire Hub Cutover Recovery',
  TaskPath:'\\',
  Principal:{UserId:'SYSTEM',RunLevel:'Highest',LogonType:'ServiceAccount'},
  Actions:[{
    Execute:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    Arguments:'-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\\ProgramData\\Nexowire\\hub-cutover-recovery\\rollback.ps1"',
  }],
  Triggers:[
    {CimClass:{CimClassName:'MSFT_TaskBootTrigger'},Enabled:true,
      Repetition:{Interval:'',Duration:''}},
    {CimClass:{CimClassName:'MSFT_TaskTimeTrigger'},Enabled:true,
      Repetition:{Interval:'PT15M',Duration:'P365D'}},
  ],
  Settings:{MultipleInstances:'IgnoreNew',StartWhenAvailable:true},
};
type TaskFixture=typeof healthyTask;

function checkWithMockTask(modify:(task:TaskFixture)=>void):string{
  const fixture=structuredClone(healthyTask);
  modify(fixture);
  const json64=Buffer.from(JSON.stringify(fixture)).toString('base64');
  const script64=Buffer.from(script).toString('base64');
  const powershell=[
    "$ErrorActionPreference='Stop'",
    "$json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+json64+"'))",
    "$fixture=$json|ConvertFrom-Json",
    'function Get-ScheduledTask { [CmdletBinding()]param([string]$TaskName,[string]$TaskPath);return $fixture }',
    "$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+script64+"'))",
    "try{$value=&([scriptblock]::Create($source));if([string]$value -cne 'OK'){throw 'UNEXPECTED_READBACK_RESULT'};'ACCEPT'}catch{'DENY:'+$_.Exception.Message}",
  ].join('\n');
  const result=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(powershell,'utf16le').toString('base64')],
    {windowsHide:true,encoding:'utf8',timeout:12000,maxBuffer:256*1024});
  assert.equal(result.status,0,result.stderr);
  return result.stdout.trim();
}

test('healthy exact recovery task passes mocked Windows readback',{
  skip:process.platform!=='win32',
},()=>assert.equal(checkWithMockTask(()=>{}),'ACCEPT'));

const attackCases:Array<{name:string;mutate:(f:TaskFixture)=>void;denial:string}>=[
  {name:'foreign task identity',mutate:f=>{f.TaskPath='\\Foreign\\';},
    denial:'IDENTITY_CHANGED'},
  {name:'wrong owner principal',mutate:f=>{f.Principal.UserId='umut';},
    denial:'PRINCIPAL_UNTRUSTED'},
  {name:'unelevated recovery principal',mutate:f=>{f.Principal.RunLevel='Limited';},
    denial:'PRINCIPAL_UNTRUSTED'},
  {name:'wrong logon type',mutate:f=>{f.Principal.LogonType='Interactive';},
    denial:'PRINCIPAL_UNTRUSTED'},
  {name:'foreign executable',mutate:f=>{f.Actions[0]!.Execute='C:\\Temp\\powershell.exe';},
    denial:'ACTION_UNTRUSTED'},
  {name:'wrong rollback script',mutate:f=>{f.Actions[0]!.Arguments+=' -ExtraFlag';},
    denial:'ACTION_UNTRUSTED'},
  {name:'duplicate action',mutate:f=>{f.Actions.push({...f.Actions[0]!});},
    denial:'ACTION_UNTRUSTED'},
  {name:'missing boot trigger',mutate:f=>{f.Triggers.shift();},
    denial:'TRIGGERS_UNTRUSTED'},
  {name:'disabled boot trigger',mutate:f=>{f.Triggers[0]!.Enabled=false;},
    denial:'TRIGGERS_UNTRUSTED'},
  {name:'unexpected recurrence',mutate:f=>{f.Triggers[1]!.Repetition.Interval='PT30M';},
    denial:'RECURRENCE_UNTRUSTED'},
  {name:'parallel task instances',mutate:f=>{f.Settings.MultipleInstances='Parallel';},
    denial:'SINGLETON_UNTRUSTED'},
  {name:'shortened recovery duration',mutate:f=>{f.Triggers[1]!.Repetition.Duration='P1D';},
    denial:'RECURRENCE_UNTRUSTED'},
  {name:'missed startup not recovered',mutate:f=>{f.Settings.StartWhenAvailable=false;},
    denial:'SETTINGS_UNTRUSTED'},
];

for(const attack of attackCases){
  test('recovery readback rejects '+attack.name,{skip:process.platform!=='win32'},()=>{
    assert.match(checkWithMockTask(attack.mutate),
      new RegExp('^DENY:AI04_RECOVERY_TASK_'+attack.denial+'$'));
  });
}
test('production confirms recovery outside rollback region before quiescing writer',()=>{
  const source=readFileSync(new URL('../scripts/ai04-controlled-system-hub-cutover.ts',import.meta.url),'utf8');
  const orchestrator=readFileSync(new URL('../src/hub/system-cutover-orchestrator.ts',import.meta.url),'utf8');
  const confirm=source.indexOf('async confirmRecoveryBeforeQuiesce(){');
  const readback=source.indexOf('runPS(systemHubRecoveryTaskReadbackScript())',confirm);
  const quiesce=source.indexOf('async quiesceLegacy(){',confirm);
  const disable=source.indexOf('Disable-ScheduledTask',quiesce);
  const orchestratorRecheck=orchestrator.indexOf('await ops.confirmRecoveryBeforeQuiesce()');
  const rollbackRegion=orchestrator.indexOf("let step:SystemCutoverStep='quiesce-legacy'");
  assert.ok(confirm>=0&&confirm<readback&&readback<quiesce&&quiesce<disable,
    'readback must occur before the first task mutation');
  assert.ok(orchestratorRecheck>=0&&orchestratorRecheck<rollbackRegion,
    'failed recovery readback must not invoke rollback of a still-running Hub');
});