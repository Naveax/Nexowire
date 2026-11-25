import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {renderMachineCutoverScript} from '../src/update/machine-update.js';

// Test child only: preserve Windows profile/TEMP, not a production launcher.
// Filter case-insensitive duplicates before overriding known inbox paths.
function fixtureEnvironment():NodeJS.ProcessEnv{
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(PATH|PSMODULEPATH|SYSTEMROOT|WINDIR)$/i.test(k)));
  return {...env,SystemRoot:'C:\\Windows',windir:'C:\\Windows',PATH:'C:\\Windows\\System32;C:\\Windows',
    PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'};
}

const script=renderMachineCutoverScript({
  version:'1.0.5',
  buildId:'1.0.5-012345abcdef',
  targetRoot:'C:\\ProgramData\\Nexowire\\versions\\1.0.5-012345abcdef',
});
const start=script.indexOf('Start-Sleep -Seconds 3');
assert.ok(start>0,'missing cutover execution block');
const actualTail=script.slice(start);

test('cutover boundary precedes first stop; legacy rollback never restarts tasks',()=>{
  const plan=script.indexOf('  Assert-CutoverPlan');
  const hubPatch=script.indexOf('  if($hasBoot){Patch-Launcher');
  const brokerPatch=script.indexOf('  if($hasBroker){Patch-Launcher');
  const cutover=script.indexOf('  $cutoverStarted=$true');
  const stop=script.indexOf('  if($hasBoot){Stop-ScheduledTask');
  assert.ok(plan>=0&&plan<cutover&&cutover<stop&&stop<hubPatch&&hubPatch<brokerPatch);
  assert.match(script,/if\(\$cutoverStarted -and \$hasBoot\)\{try\{Stop-ScheduledTask/);
  assert.match(script,/if\(\$cutoverStarted -and \$hasBroker\)\{try\{Stop-ScheduledTask/);
  const fallback=script.slice(script.lastIndexOf('\r\n} catch {\r\n'));
  assert.match(fallback,/MACHINE_UPDATE_SIGNED_SQLITE_ROLLBACK_AUTHORITY_REQUIRED/);
  assert.doesNotMatch(fallback,/Start-ScheduledTask|Wait-Service/);
  assert.match(script,/if\(\$rollbackErrors.Count -gt 0\)/);
  assert.match(script,/\$previousRoots\[\$file\]=\$oldRoot/);

  assert.match(script,/\$runtimeRoot=\$NewRoot/);
});

type Scenario ={
  name:string;
  failPhase:'plan'|'secondPatch'|'health'|'none';
  restoreFails?:boolean;
  expectedStatus:'rolled_back'|'rollback_failed'|'succeeded';
  restoredListenerFails?:boolean;
  expectedStops:number;
  expectedStarts:number;
  expectedRestores:number;
  expectedExit:number;
};
const cases:Scenario[]=[
  {name:'preflight failure leaves both running tasks untouched',
   failPhase:'plan',expectedStatus:'rolled_back',expectedStops:0,expectedStarts:0,expectedRestores:1,expectedExit:1},
  {name:'partial patch after stop retains evidence and denies fallback',
   failPhase:'secondPatch',expectedStatus:'rollback_failed',expectedStops:4,expectedStarts:0,expectedRestores:0,expectedExit:2},
  {name:'preflight cleanup failure reports rollback_failed without task bounce',
   failPhase:'plan',restoreFails:true,expectedStatus:'rollback_failed',expectedStops:0,expectedStarts:0,expectedRestores:1,expectedExit:2},
  {name:'failed live cutover stops tasks but never restarts previous runtime',
   failPhase:'health',expectedStatus:'rollback_failed',expectedStops:4,expectedStarts:1,expectedRestores:0,expectedExit:2},
  {name:'prior listener health cannot authorize a stale runtime restart',
   failPhase:'health',restoredListenerFails:true,expectedStatus:'rollback_failed',expectedStops:4,expectedStarts:1,expectedRestores:0,expectedExit:2},
  {name:'successful cutover starts both planned tasks and claims success',
   failPhase:'none',expectedStatus:'succeeded',expectedStops:2,expectedStarts:2,expectedRestores:0,expectedExit:0},
];

for(const scenario of cases){
  test(scenario.name,{skip:process.platform!=='win32'},()=>{
    const source=[
      "$ErrorActionPreference='Stop'",
      '[Console]::Error.WriteLine("AI05_PS_STARTED")',
      "Import-Module -Name 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1' -ErrorAction Stop",
      '[Console]::Error.WriteLine("AI05_PS_UTILITY_LOADED")',
      "$BootLauncher='C:\\ProgramData\\Nexowire\\hub-boot\\launch.ps1'",
      "$BrokerLauncher='C:\\ProgramData\\Nexowire\\privileged-broker\\launch.ps1'",
      "$BootTask='Nexowire Hub Boot'",
      "$BrokerTask='Nexowire Privileged Broker'",
      '$script:stops=0',
      '$script:starts=0',
      '$script:patches=0',
      '$script:restores=0',
      '$script:previousRoots=@{}',
      'function Start-Sleep {param([int]$Seconds)}',
      'function Task-Exists {param([string]$name) return $true}',
      'function Assert-CutoverPlan {',
      scenario.failPhase==='plan'?"  throw 'PLAN_FAILED'":'  return',
      '}',
      'function Patch-Launcher {param([string]$file) $script:patches++; $script:previousRoots[$file]="C:\\ProgramData\\Nexowire\\versions\\1.0.4-012345abcdef";'+(
        scenario.failPhase==='secondPatch'?
        " if($script:patches -eq 2){throw 'BROKER_PATCH_FAILED'}":''
      )+'}',
      'function Stop-ScheduledTask {param([string]$TaskName,[string]$ErrorAction) $script:stops++}',
      'function Start-ScheduledTask {param([string]$TaskName,[string]$ErrorAction) $script:starts++}',
      'function Restore { $script:restores++;'+(scenario.restoreFails?"throw 'RESTORE_FAILED'":'')+'}',
      'function Wait-Service {param([int]$port,[string]$needle,[int]$seconds,[string]$runtimeRoot) if($runtimeRoot){return '+(scenario.restoredListenerFails?'$false':'$true')+'}; return '+(
        scenario.failPhase==='health'?'$false':'$true'
      )+'}',
      'function Write-Status {param([string]$state,[string]$message)',
      '  [pscustomobject]@{state=$state;message=$message;stops=$script:stops;starts=$script:starts;patches=$script:patches;restores=$script:restores}|ConvertTo-Json -Compress',
      '}',
      '[Console]::Error.WriteLine("AI05_PS_CUTOVER_FIXTURE_ENTERED")',
      actualTail,
    ].join('\r\n');
    const started=performance.now();
    const child=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
        Buffer.from(source,'utf16le').toString('base64')],{
        cwd:'C:\\Windows\\System32',
        // PowerShell 5.1 needs the real profile/temp environment, just as
        // the passing rollback-integrity fixture does. Restrict PATH and modules.
        env:fixtureEnvironment(),
        encoding:'utf8',timeout:10_000,maxBuffer:128*1024,windowsHide:true,
      });
    const diagnostic=JSON.stringify({error:(child.error as NodeJS.ErrnoException|undefined)?.code??null,signal:child.signal,status:child.status,elapsedMs:Math.round(performance.now()-started),stdout:child.stdout,stderr:child.stderr});
    assert.equal(child.error,undefined,diagnostic);
    assert.equal(child.signal,null,diagnostic);
    assert.equal(child.status,scenario.expectedExit,diagnostic);
    assert.match(child.stderr,/AI05_PS_CUTOVER_FIXTURE_ENTERED/);
    const records=child.stdout.trim().split(/\r?\n/).filter(Boolean);
    assert.equal(records.length,1,child.stdout);
    const result=JSON.parse(records[0] ?? '') as {
      state:string;message:string;stops:number;starts:number;patches:number;restores:number;
    };
    assert.equal(result.state,scenario.expectedStatus);
    assert.equal(result.stops,scenario.expectedStops);
    assert.equal(result.starts,scenario.expectedStarts);
    assert.equal(result.restores,scenario.expectedRestores);
    if(scenario.failPhase==='secondPatch'||scenario.failPhase==='health')assert.match(result.message,/MACHINE_UPDATE_SIGNED_SQLITE_ROLLBACK_AUTHORITY_REQUIRED/);
  });
}
