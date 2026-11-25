import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const fenceFunctions=script.slice(script.indexOf('function Get-ActivationTask('),script.indexOf('function Wait-Service('));
assert.ok(fenceFunctions.includes('function Clear-ActivationFence'));
const q=(s:string)=>"'"+s.replaceAll("'","''")+"'";

test('cutover boundary precedes first stop; legacy rollback never restarts tasks',()=>{
  const plan=script.indexOf('  Assert-CutoverPlan');
  const hubPatch=script.indexOf('  if($hasBoot){Patch-Launcher');
  const brokerPatch=script.indexOf('  if($hasBroker){Patch-Launcher');
  const cutover=script.indexOf('  $cutoverStarted=$true');
  const disable=script.indexOf('  if($hasBroker){Disable-ActivationTask');
  const stop=script.indexOf('Stop-ScheduledTask -TaskName $BootTask',cutover);
  assert.ok(plan>=0&&plan<cutover&&cutover<disable&&disable<stop&&stop<hubPatch&&hubPatch<brokerPatch);
  assert.match(script,/if\(\$hasBoot\)\{try\{Disable-ActivationTask/);
  assert.match(script,/if\(\$hasBroker\)\{try\{Disable-ActivationTask/);
  const fallback=script.slice(script.lastIndexOf('\r\n} catch {\r\n'));
  assert.match(fallback,/MACHINE_UPDATE_SIGNED_SQLITE_ROLLBACK_AUTHORITY_REQUIRED/);
  assert.doesNotMatch(fallback,/Start-ScheduledTask|Wait-Service|Enable-ForwardActivation|Clear-ActivationFence/);
  assert.match(script,/if\(\$rollbackErrors.Count -gt 0\)/);
  assert.match(script,/\$previousRoots\[\$file\]=\$oldRoot/);

  assert.match(script,/\$runtimeRoot=\$NewRoot/);
});

type Scenario ={
  name:string;
  failPhase:'plan'|'secondPatch'|'health'|'none'|'disable'|'readback'|'identity'|'existing'|'alreadyDisabled'|'enable';
  restoreFails?:boolean;
  expectedStatus:'rolled_back'|'rollback_failed'|'succeeded';
  restoredListenerFails?:boolean;
  expectedStops:number;
  expectedStarts:number;
  expectedRestores:number;
  expectedExit:number;
  expectedEnabled?:number;
  expectedPatches?:number;
  expectedFence?:boolean;
  expectedMessage?:RegExp;
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
   failPhase:'none',expectedStatus:'succeeded',expectedStops:2,expectedStarts:2,expectedRestores:0,expectedExit:0,expectedEnabled:2,expectedPatches:2,expectedFence:false},
  {name:'disable denial never patches or enables a launcher and retains recovery marker',failPhase:'disable',expectedStatus:'rollback_failed',expectedStops:2,expectedStarts:0,expectedRestores:0,expectedExit:2,expectedEnabled:1,expectedPatches:0,expectedFence:true,expectedMessage:/BROKER_ACTIVATION_FENCE_UNVERIFIED/},
  {name:'false disabled readback never patches a launcher',failPhase:'readback',expectedStatus:'rollback_failed',expectedStops:2,expectedStarts:0,expectedRestores:0,expectedExit:2,expectedEnabled:1,expectedPatches:0,expectedFence:true,expectedMessage:/BROKER_ACTIVATION_FENCE_UNVERIFIED/},
  {name:'existing durable fence refuses even a new forward update',failPhase:'existing',expectedStatus:'rollback_failed',expectedStops:0,expectedStarts:0,expectedRestores:0,expectedExit:2,expectedEnabled:2,expectedPatches:0,expectedFence:true,expectedMessage:/SIGNED_SQLITE_ROLLBACK_AUTHORITY_REQUIRED/},
  {name:'previously disabled task cannot be reactivated by ordinary update',failPhase:'alreadyDisabled',expectedStatus:'rollback_failed',expectedStops:0,expectedStarts:0,expectedRestores:0,expectedExit:2,expectedEnabled:1,expectedPatches:0,expectedFence:false,expectedMessage:/SIGNED_SQLITE_ROLLBACK_AUTHORITY_REQUIRED/},
  {name:'changed task owner is not stopped or activated',failPhase:'identity',expectedStatus:'rollback_failed',expectedStops:1,expectedStarts:0,expectedRestores:0,expectedExit:2,expectedEnabled:1,expectedPatches:0,expectedFence:true,expectedMessage:/ACTIVATION_IDENTITY_CHANGED/},
  {name:'failed forward enable re-disables both tasks without old runtime restart',failPhase:'enable',expectedStatus:'rollback_failed',expectedStops:4,expectedStarts:0,expectedRestores:0,expectedExit:2,expectedEnabled:0,expectedPatches:2,expectedFence:true,expectedMessage:/SIGNED_SQLITE_ROLLBACK_AUTHORITY_REQUIRED/},
];

for(const scenario of cases){
  test(scenario.name,{skip:process.platform!=='win32'},()=>{
    const root=mkdtempSync(path.join(os.tmpdir(),'nx-machine-fence-'));
    const marker=path.join(root,'machine-activation-fence.json');
    const sentinel='previous independently unresolved recovery';
    if(scenario.failPhase==='existing')writeFileSync(marker,sentinel);
    try {
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
      '$ActivationFence='+q(marker),
      "$NewRoot='C:\\ProgramData\\Nexowire\\versions\\1.0.5-012345abcdef'",
      "$BuildId='1.0.5-012345abcdef'",
      '$fenceIdentities=@{}','$forwardHashes=@{}','$fenceOwned=$false','$recoveryRequired=$false','$fenceHash=$null','$cutoverStarted=$false',
      '$failPhase='+q(scenario.failPhase),
      '$tasks=@{}',
      "foreach($n in @($BootTask,$BrokerTask)){$tasks[$n]=[pscustomobject]@{TaskName=$n;TaskPath='\\';Principal=[pscustomobject]@{UserId=('owner-'+$n)};Settings=[pscustomobject]@{Enabled=$true};State='Ready'}}",
      "if($failPhase -eq 'alreadyDisabled'){$tasks[$BootTask].Settings.Enabled=$false;$tasks[$BootTask].State='Disabled'}",
      'function Start-Sleep {param([int]$Seconds)}',
      'function Task-Exists {param([string]$name) return $true}',
      'function Assert-CutoverPlan {',
      scenario.failPhase==='plan'?"  throw 'PLAN_FAILED'":'  return',
      '}',
      'function Patch-Launcher {param([string]$file) $script:patches++; $script:previousRoots[$file]="C:\\ProgramData\\Nexowire\\versions\\1.0.4-012345abcdef";'+(
        scenario.failPhase==='secondPatch'?
        " if($script:patches -eq 2){throw 'BROKER_PATCH_FAILED'}":''
      )+'}',
      'function Assert-TaskIdentity {param([string]$name,[string]$launcher,[bool]$mustBeSystem,[switch]$ReturnTask) if($ReturnTask){return $tasks[$name]}}',
      'function Disable-ScheduledTask {param([string]$TaskName,[string]$TaskPath,[string]$ErrorAction)',
      " if($TaskPath -cne '\\'){throw 'FOREIGN_PATH'}",
      " if($TaskName -eq $BrokerTask -and $failPhase -eq 'disable'){throw 'DENIED_DISABLE'}",
      " if($TaskName -eq $BrokerTask -and $failPhase -eq 'readback'){return}",
      " $tasks[$TaskName].Settings.Enabled=$false;$tasks[$TaskName].State='Disabled'",
      " if($TaskName -eq $BootTask -and $failPhase -eq 'identity'){$tasks[$BrokerTask].Principal.UserId='replacement-owner'}",
      '}',
      'function Enable-ScheduledTask {param([string]$TaskName,[string]$TaskPath,[string]$ErrorAction)',
      " if($TaskPath -cne '\\' -or $script:patches -ne 2){throw 'UNSAFE_ENABLE'}",
      " if($failPhase -eq 'enable'){throw 'DENIED_ENABLE'}",
      " $tasks[$TaskName].Settings.Enabled=$true;$tasks[$TaskName].State='Ready'",
      '}',
      'function Stop-ScheduledTask {param([string]$TaskName,[string]$TaskPath,[string]$ErrorAction) if($TaskPath -cne "\\"){throw "FOREIGN_PATH"};$script:stops++}',
      'function Start-ScheduledTask {param([string]$TaskName,[string]$TaskPath,[string]$ErrorAction) if($TaskPath -cne "\\" -or -not $tasks[$TaskName].Settings.Enabled -or $script:patches -ne 2){throw "UNSAFE_START"};$script:starts++}',
      fenceFunctions,
      // File hash/readback is exercised separately with actual files; the
      // full cutover fixture models the scheduler and launcher patch effects.
      'function Read-ForwardLauncherHash {param([string]$file) if($script:patches -lt 1){throw "UNPATCHED"};return "fixture-forward-hash"}',
      'function Restore { $script:restores++;'+(scenario.restoreFails?"throw 'RESTORE_FAILED'":'')+'}',
      'function Wait-Service {param([int]$port,[string]$needle,[int]$seconds,[string]$runtimeRoot) if($runtimeRoot){return '+(scenario.restoredListenerFails?'$false':'$true')+'}; return '+(
        scenario.failPhase==='health'?'$false':'$true'
      )+'}',
      'function Write-Status {param([string]$state,[string]$message)',
      '  [pscustomobject]@{state=$state;message=$message;stops=$script:stops;starts=$script:starts;patches=$script:patches;restores=$script:restores;enabled=@($tasks.Values|Where-Object{$_.Settings.Enabled}).Count}|ConvertTo-Json -Compress',
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
      state:string;message:string;stops:number;starts:number;patches:number;restores:number;enabled:number;
    };
    assert.equal(result.state,scenario.expectedStatus);
    assert.equal(result.stops,scenario.expectedStops);
    assert.equal(result.starts,scenario.expectedStarts);
    assert.equal(result.restores,scenario.expectedRestores);
    if(scenario.failPhase==='secondPatch'||scenario.failPhase==='health')assert.match(result.message,/MACHINE_UPDATE_SIGNED_SQLITE_ROLLBACK_AUTHORITY_REQUIRED/);
    if(scenario.expectedMessage)assert.match(result.message,scenario.expectedMessage);
    const changed=scenario.failPhase==='secondPatch'||scenario.failPhase==='health';
    assert.equal(result.enabled,scenario.expectedEnabled??(changed?0:2));
    assert.equal(existsSync(marker),scenario.expectedFence??changed);
    if(scenario.expectedPatches!==undefined)assert.equal(result.patches,scenario.expectedPatches);
    if(scenario.failPhase==='existing')assert.equal(readFileSync(marker,'utf8'),sentinel);
    else if(existsSync(marker)){
      const persisted=JSON.parse(readFileSync(marker,'utf8'));
      assert.equal(persisted.buildId,'1.0.5-012345abcdef');
      assert.equal(Object.keys(persisted.principals).length,2);
    }
    }finally{rmSync(root,{recursive:true,force:true});}
  });
}
