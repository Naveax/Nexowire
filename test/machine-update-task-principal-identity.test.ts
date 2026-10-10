import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {renderMachineCutoverScript} from '../src/update/machine-update.js';

const script=renderMachineCutoverScript({
  version:'1.0.5',
  buildId:'1.0.5-012345abcdef',
  targetRoot:'C:\\ProgramData\\Nexowire\\versions\\1.0.5-012345abcdef',
});
const lines=script.split(/\r?\n/);
const start=lines.findIndex(x=>x.startsWith('function Assert-TaskIdentity('));
const end=lines.findIndex((x,i)=>i>start&&x==='}');
assert.ok(start>=0&&end>start);
const verifier=lines.slice(start,end+1).join('\r\n');

test('cutover checks task principal, elevated run level, root task path and exact launcher command',()=>{
  assert.match(script,/function Assert-TaskIdentity\(/);
  assert.match(script,/Get-ScheduledTask -TaskName \$name -TaskPath '\\' -ErrorAction Stop/);
  assert.match(script,/MACHINE_UPDATE_TASK_NOT_ELEVATED/);
  assert.match(script,/MACHINE_UPDATE_HUB_PRINCIPAL_UNTRUSTED/);
  assert.match(script,/MACHINE_UPDATE_BROKER_PRINCIPAL_UNTRUSTED/);
  assert.match(script,/MACHINE_UPDATE_TASK_ACTION_COUNT_INVALID/);
  assert.match(script,/MACHINE_UPDATE_TASK_ACTION_UNTRUSTED/);
  const preflight=script.indexOf('  Assert-CutoverPlan');
  const patch=script.indexOf('Patch-Launcher $BootLauncher',preflight);
  assert.ok(preflight>=0&&patch>preflight);
  assert.ok(script.includes('if($hasBoot){Assert-TaskIdentity $BootTask $BootLauncher $true}'));
  assert.ok(script.includes('if($hasBroker){Assert-TaskIdentity $BrokerTask $BrokerLauncher $false}'));
});

type Case={
  name:string;
  system:boolean;
  principal:string;
  runLevel:string;
  logonType:string;
  executable:string;
  args?:string;
  secondAction?:boolean;
  missing?:boolean;
  expected:string;
};

const psExe='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const hubLauncher='C:\\ProgramData\\Nexowire\\hub-boot\\launch.ps1';
const brokerLauncher='C:\\ProgramData\\Nexowire\\privileged-broker\\launch.ps1';
const expectedArg=(launcher:string)=>
  '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+launcher+'"';
const cases:Case[]=[
  {name:'SYSTEM Hub has exact first-party task principal and launcher',system:true,principal:'SYSTEM',runLevel:'Highest',logonType:'ServiceAccount',executable:psExe,expected:'PASS'},
  {name:'elevated interactive Broker has exact first-party launcher',system:false,principal:'MACHINE\\operator',runLevel:'Highest',logonType:'Interactive',executable:psExe,expected:'PASS'},
  {name:'Hub task cannot run under ordinary user',system:true,principal:'MACHINE\\operator',runLevel:'Highest',logonType:'ServiceAccount',executable:psExe,expected:'MACHINE_UPDATE_HUB_PRINCIPAL_UNTRUSTED'},
  {name:'Hub SYSTEM task cannot use interactive logon',system:true,principal:'SYSTEM',runLevel:'Highest',logonType:'Interactive',executable:psExe,expected:'MACHINE_UPDATE_HUB_PRINCIPAL_UNTRUSTED'},
  {name:'Broker task cannot impersonate SYSTEM',system:false,principal:'SYSTEM',runLevel:'Highest',logonType:'Interactive',executable:psExe,expected:'MACHINE_UPDATE_BROKER_PRINCIPAL_UNTRUSTED'},
  {name:'Broker task cannot use service account logon',system:false,principal:'MACHINE\\operator',runLevel:'Highest',logonType:'ServiceAccount',executable:psExe,expected:'MACHINE_UPDATE_BROKER_PRINCIPAL_UNTRUSTED'},
  {name:'Hub without Highest privilege is refused',system:true,principal:'SYSTEM',runLevel:'Limited',logonType:'ServiceAccount',executable:psExe,expected:'MACHINE_UPDATE_TASK_NOT_ELEVATED'},
  {name:'Hub cannot execute PATH-selected PowerShell',system:true,principal:'SYSTEM',runLevel:'Highest',logonType:'ServiceAccount',executable:'powershell.exe',expected:'MACHINE_UPDATE_TASK_ACTION_UNTRUSTED'},
  {name:'Hub cannot execute arbitrary script',system:true,principal:'SYSTEM',runLevel:'Highest',logonType:'ServiceAccount',executable:psExe,args:'-NoProfile -File C:\\Users\\Public\\evil.ps1',expected:'MACHINE_UPDATE_TASK_ACTION_UNTRUSTED'},
  {name:'extra scheduled task action is refused',system:true,principal:'SYSTEM',runLevel:'Highest',logonType:'ServiceAccount',executable:psExe,secondAction:true,expected:'MACHINE_UPDATE_TASK_ACTION_COUNT_INVALID'},
  {name:'disappearing task fails closed',system:true,principal:'SYSTEM',runLevel:'Highest',logonType:'ServiceAccount',executable:psExe,missing:true,expected:'MACHINE_UPDATE_TASK_DISAPPEARED'},
];

function quote(x:string):string{return "'"+x.replaceAll("'","''")+"'";}
for(const item of cases){
  test(item.name,{skip:process.platform!=='win32'},()=>{
    const launcher=item.system?hubLauncher:brokerLauncher;
    const args=item.args??expectedArg(launcher);
    const fixture=[
      "$ErrorActionPreference='Stop'",
      '$launcher='+quote(launcher),
      '$taskName='+quote(item.system?'Nexowire Hub Boot':'Nexowire Privileged Broker'),
      '$action=[pscustomobject]@{Execute='+quote(item.executable)+';Arguments='+quote(args)+'}',
      '$principal=[pscustomobject]@{UserId='+quote(item.principal)+';RunLevel='+quote(item.runLevel)+';LogonType='+quote(item.logonType)+'}',
      '$actions=@($action)',
      ...(item.secondAction?['$actions+=@($action)']:[]),
      '$task=[pscustomobject]@{Principal=$principal;Actions=$actions}',
      'function Get-ScheduledTask { param([string]$TaskName,[string]$TaskPath,[string]$ErrorAction) '+(item.missing?'return $null':'return $task')+' }',
      verifier,
      'try {Assert-TaskIdentity $taskName $launcher $'+(item.system?'true':'false')+";[Console]::WriteLine('PASS')}",
      'catch {[Console]::WriteLine($_.Exception.Message)}',
    ].join('\r\n');
    const r=spawnSync(psExe,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(fixture,'utf16le').toString('base64')],{
      cwd:'C:\\Windows\\System32',windowsHide:true,
      env:{SystemRoot:'C:\\Windows',windir:'C:\\Windows',PATH:'C:\\Windows\\System32;C:\\Windows',PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'},
      encoding:'utf8',timeout:10_000,maxBuffer:128*1024,
    });
    assert.equal(r.status,0,r.stderr);
    assert.equal(r.stdout.trim(),item.expected);
  });
}
