import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {renderMachineCutoverScript} from '../src/update/machine-update.js';

const script=renderMachineCutoverScript({
  version:'1.0.5',
  buildId:'1.0.5-012345abcdef',
  targetRoot:'C:\\ProgramData\\Nexowire\\versions\\1.0.5-012345abcdef',
});
const start=script.indexOf('Start-Sleep -Seconds 3');
assert.ok(start>0,'missing cutover execution block');
const actualTail=script.slice(start);

test('rollback only bounces tasks when the cutover phase has started',()=>{
  const plan=script.indexOf('  Assert-CutoverPlan');
  const hubPatch=script.indexOf('  if($hasBoot){Patch-Launcher');
  const brokerPatch=script.indexOf('  if($hasBroker){Patch-Launcher');
  const cutover=script.indexOf('  $cutoverStarted=$true');
  const stop=script.indexOf('  if($hasBoot){Stop-ScheduledTask');
  assert.ok(plan>=0&&plan<hubPatch&&hubPatch<brokerPatch&&brokerPatch<cutover&&cutover<stop);
  assert.match(script,/if\(\$cutoverStarted -and \$hasBoot\)\{try\{Stop-ScheduledTask/);
  assert.match(script,/if\(\$cutoverStarted -and \$hasBroker\)\{try\{Stop-ScheduledTask/);
  assert.match(script,/if\(\$cutoverStarted -and \$hasBoot\)\{try\{Start-ScheduledTask/);
  assert.match(script,/if\(\$cutoverStarted -and \$hasBroker\)\{try\{Start-ScheduledTask/);
  assert.match(script,/if\(\$rollbackErrors.Count -gt 0\)/);
});

type Scenario ={
  name:string;
  failPhase:'plan'|'secondPatch'|'health'|'none';
  restoreFails?:boolean;
  expectedStatus:'rolled_back'|'rollback_failed'|'succeeded';
  expectedStops:number;
  expectedStarts:number;
  expectedRestores:number;
  expectedExit:number;
};
const cases:Scenario[]=[
  {name:'preflight failure leaves both running tasks untouched',
   failPhase:'plan',expectedStatus:'rolled_back',expectedStops:0,expectedStarts:0,expectedRestores:1,expectedExit:1},
  {name:'second launcher patch failure restores first without bouncing either live task',
   failPhase:'secondPatch',expectedStatus:'rolled_back',expectedStops:0,expectedStarts:0,expectedRestores:1,expectedExit:1},
  {name:'failed recovery before task cutover reports rollback_failed without service disruption',
   failPhase:'secondPatch',restoreFails:true,expectedStatus:'rollback_failed',expectedStops:0,expectedStarts:0,expectedRestores:1,expectedExit:2},
  {name:'failed live cutover still stops and restarts both tasks during rollback',
   failPhase:'health',expectedStatus:'rolled_back',expectedStops:4,expectedStarts:3,expectedRestores:1,expectedExit:1},
  {name:'successful cutover starts both planned tasks and claims success',
   failPhase:'none',expectedStatus:'succeeded',expectedStops:2,expectedStarts:2,expectedRestores:0,expectedExit:0},
];

for(const scenario of cases){
  test(scenario.name,{skip:process.platform!=='win32'},()=>{
    const source=[
      "$ErrorActionPreference='Stop'",
      "$BootLauncher='C:\\ProgramData\\Nexowire\\hub-boot\\launch.ps1'",
      "$BrokerLauncher='C:\\ProgramData\\Nexowire\\privileged-broker\\launch.ps1'",
      "$BootTask='Nexowire Hub Boot'",
      "$BrokerTask='Nexowire Privileged Broker'",
      '$script:stops=0',
      '$script:starts=0',
      '$script:patches=0',
      '$script:restores=0',
      'function Start-Sleep {param([int]$Seconds)}',
      'function Task-Exists {param([string]$name) return $true}',
      'function Assert-CutoverPlan {',
      scenario.failPhase==='plan'?"  throw 'PLAN_FAILED'":'  return',
      '}',
      'function Patch-Launcher {param([string]$file) $script:patches++;'+(
        scenario.failPhase==='secondPatch'?
        " if($script:patches -eq 2){throw 'BROKER_PATCH_FAILED'}":''
      )+'}',
      'function Stop-ScheduledTask {param([string]$TaskName,[string]$ErrorAction) $script:stops++}',
      'function Start-ScheduledTask {param([string]$TaskName,[string]$ErrorAction) $script:starts++}',
      'function Restore { $script:restores++;'+(scenario.restoreFails?"throw 'RESTORE_FAILED'":'')+'}',
      'function Wait-Service {param([int]$port,[string]$needle,[int]$seconds) return '+(
        scenario.failPhase==='health'?'$false':'$true'
      )+'}',
      'function Write-Status {param([string]$state,[string]$message)',
      '  [pscustomobject]@{state=$state;message=$message;stops=$script:stops;starts=$script:starts;patches=$script:patches;restores=$script:restores}|ConvertTo-Json -Compress',
      '}',
      actualTail,
    ].join('\r\n');
    const child=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
        Buffer.from(source,'utf16le').toString('base64')],{
        cwd:'C:\\Windows\\System32',
        env:{
          SystemRoot:'C:\\Windows',windir:'C:\\Windows',
          PATH:'C:\\Windows\\System32;C:\\Windows',
          PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
        },
        encoding:'utf8',timeout:10_000,maxBuffer:128*1024,windowsHide:true,
      });
    assert.equal(child.status,scenario.expectedExit,child.stderr);
    const records=child.stdout.trim().split(/\r?\n/).filter(Boolean);
    assert.equal(records.length,1,child.stdout);
    const result=JSON.parse(records[0] ?? '') as {
      state:string;message:string;stops:number;starts:number;patches:number;restores:number;
    };
    assert.equal(result.state,scenario.expectedStatus);
    assert.equal(result.stops,scenario.expectedStops);
    assert.equal(result.starts,scenario.expectedStarts);
    assert.equal(result.restores,scenario.expectedRestores);
  });
}
