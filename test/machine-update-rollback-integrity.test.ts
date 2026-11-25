import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {renderMachineCutoverScript} from '../src/update/machine-update.js';

const script=renderMachineCutoverScript({
  version:'1.0.5',buildId:'1.0.5-012345abcdef',
  targetRoot:'C:\\ProgramData\\Nexowire\\versions\\1.0.5-012345abcdef',
});
const rollbackMarker='\r\n} catch {\r\n';
const rollbackStart=script.lastIndexOf(rollbackMarker);
assert.ok(rollbackStart>0,'missing cutover catch/rollback block');
const rollback=script.slice(rollbackStart+2);
const restore=script.split(/\r?\n/).find(s=>s.startsWith('function Restore '));
assert.ok(restore);

const win=process.platform==='win32';
const pwsh='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
// Keep PowerShell 5.1 module resolution deterministic, but provide the
// host's real TEMP/profile environment so command/module initialization can
// complete on GitHub's Windows runner. Scope this only to test children.
const env={
  ...process.env,
  SystemRoot:'C:\\Windows',windir:'C:\\Windows',
  PATH:'C:\\Windows\\System32;C:\\Windows',
  PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
};
function run(scriptText:string){
  return spawnSync(pwsh,
    ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(scriptText,'utf16le').toString('base64')],{
      cwd:'C:\\Windows\\System32',env,encoding:'utf8',timeout:15000,maxBuffer:160*1024,
    });
}

test('a failed rollback has its own status, never successfully rolled_back',()=>{
  assert.match(script,/rollback_failed/);
  assert.match(script,/LAUNCHER_RESTORE:/);
  assert.match(rollback,/MACHINE_UPDATE_SIGNED_SQLITE_ROLLBACK_AUTHORITY_REQUIRED/);
  assert.doesNotMatch(rollback,/Start-ScheduledTask|Wait-Service/);
  assert.ok(rollback.indexOf('MACHINE_UPDATE_SIGNED_SQLITE_ROLLBACK_AUTHORITY_REQUIRED')<rollback.indexOf('try{Restore}'));
  assert.match(script,/Get-FileHash -LiteralPath \$entry\.Value -Algorithm SHA256/);
  assert.match(script,/MACHINE_UPDATE_LAUNCHER_RESTORE_MISMATCH/);
  assert.match(script,/Write-Status 'rolled_back' \$message/);
  assert.match(script,/Write-Status 'rollback_failed'/);
});

const scenarios=[
  {name:'healthy prior runtime cannot substitute for signed rollback authority',stopFail:''},
  {name:'Hub stop denied preserves recovery evidence and refuses restart',stopFail:'hub'},
  {name:'Broker stop denied preserves recovery evidence and refuses restart',stopFail:'broker'},
  {name:'failed cutover never restores an unverified launcher',stopFail:''},
  {name:'unknown cutover state cannot become rolled_back',stopFail:'broker'},
]as const;
for(const s of scenarios){
  test(s.name,{skip:!win},()=>{
    const scriptText=[
      "$ErrorActionPreference='Stop'",
      "$BootTask='Nexowire Hub Boot'",
      "$BrokerTask='Nexowire Privileged Broker'",
      '$hasBoot=$true','$hasBroker=$true','$cutoverStarted=$true',
      '$fenceOwned=$true','$recoveryRequired=$false',
      "$BootLauncher='fixture-boot'","$BrokerLauncher='fixture-broker'",
      'function Disable-ActivationTask {param([string]$name,[string]$launcher,[bool]$system)}',
      'function Assert-ActivationTask {param([string]$name,[string]$launcher,[bool]$system)}',
      'function Assert-ActivationDisabled {param([string]$name,[string]$launcher,[bool]$system)}',
      '$stopFail='+JSON.stringify(s.stopFail),
      'function Stop-ScheduledTask {[CmdletBinding()]param([string]$TaskName,[string]$TaskPath)',
      "  if(($stopFail -eq 'broker' -and $TaskName -eq $BrokerTask) -or ($stopFail -eq 'hub' -and $TaskName -eq $BootTask)){throw 'STOP_SYNTHETIC_FAILURE'}",
      '}',
      'function Start-ScheduledTask {throw "UNAUTHORIZED_START"}',
      'function Enable-ForwardActivation {throw "UNAUTHORIZED_ENABLE"}',
      'function Clear-ActivationFence {throw "UNAUTHORIZED_CLEAR"}',
      'function Restore {throw "UNAUTHORIZED_RESTORE"}',
      'function Wait-Service {throw "UNAUTHORIZED_HEALTH_AS_PERMISSION"}',
      'function Write-Status {param([string]$state,[string]$message);[Console]::WriteLine("STATUS="+$state+";"+$message)}',
      "try {throw 'ORIGINAL_UPDATE_FAILURE'",
      rollback,
    ].join('\r\n');
    const output=run(scriptText);
    assert.equal(output.status,2,output.stderr+'\n'+output.stdout);
    assert.match(output.stdout,/STATUS=rollback_failed;/);
    assert.match(output.stdout,/ORIGINAL_UPDATE_FAILURE/);
    assert.match(output.stdout,/MACHINE_UPDATE_SIGNED_SQLITE_ROLLBACK_AUTHORITY_REQUIRED/);
    assert.doesNotMatch(output.stdout,/UNAUTHORIZED_(START|RESTORE|HEALTH|ENABLE|CLEAR)|STATUS=rolled_back/);
    if(s.stopFail)assert.match(output.stdout,/STOP_SYNTHETIC_FAILURE/);
  });
}

test('real file rollback restores original launcher content and verifies checksum',{
  skip:!win,
},()=>{
  const root=mkdtempSync(path.join(tmpdir(),'nx-machine-rollback-'));
  try{
    const launcher=path.join(root,'launch.ps1');
    const backup=launcher+'.update-rollback';
    const q=(s:string)=>"'"+s.replaceAll("'","''")+"'";
    const fixture=[
      "$ErrorActionPreference='Stop'",
      '$original='+q('ORIGINAL_LAUNCHER_CODE'),
      'Set-Content -LiteralPath '+q(backup)+' -Value $original -Encoding UTF8',
      'Set-Content -LiteralPath '+q(launcher)+' -Value "CHANGED_LAUNCHER_CODE" -Encoding UTF8',
      '$backups=@{}',
      '$backups['+q(launcher)+']='+q(backup),
      restore!,
      'Restore',
      'if((Get-Content -LiteralPath '+q(launcher)+' -Raw).Trim() -ne $original){throw "NOT_RESTORED"}',
      '[Console]::WriteLine("RESTORE_PASS")',
    ].join('\r\n');
    const output=run(fixture);
    assert.equal(output.status,0,`PowerShell restore: ${String(output.error)}\n${output.stderr}\n${output.stdout}`);
    assert.match(output.stdout,/RESTORE_PASS/);
  }finally{
    rmSync(root,{recursive:true,force:true});
  }
});
