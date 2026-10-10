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
const env={
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
  assert.match(script,/HUB_RESTART:/);
  assert.match(script,/BROKER_RESTART:/);
  assert.match(script,/Get-FileHash -LiteralPath \$entry\.Value -Algorithm SHA256/);
  assert.match(script,/MACHINE_UPDATE_LAUNCHER_RESTORE_MISMATCH/);
  assert.match(script,/Write-Status 'rolled_back' \$message/);
  assert.match(script,/Write-Status 'rollback_failed'/);
});

const scenarios=[
  {name:'clean restoration has rolled_back status',stopFail:'',startFail:'',restoreFail:false,status:'rolled_back',code:1},
  {name:'launcher restoration failure reports rollback_failed',stopFail:'',startFail:'',restoreFail:true,status:'rollback_failed',code:2},
  {name:'Hub restart failure reports rollback_failed',stopFail:'',startFail:'hub',restoreFail:false,status:'rollback_failed',code:2},
  {name:'Broker restart failure reports rollback_failed',stopFail:'',startFail:'broker',restoreFail:false,status:'rollback_failed',code:2},
  {name:'failed stop and restore both reported',stopFail:'broker',startFail:'hub',restoreFail:true,status:'rollback_failed',code:2},
]as const;

for(const s of scenarios){
  test(s.name,{skip:!win},()=>{
    const scriptText=[
      "$ErrorActionPreference='Stop'",
      "$BootTask='Nexowire Hub Boot'",
      "$BrokerTask='Nexowire Privileged Broker'",
      '$hasBoot=$true',
      '$hasBroker=$true',
      '$backups=@{}',
      '$stopFail='+JSON.stringify(s.stopFail),
      '$startFail='+JSON.stringify(s.startFail),
      '$restoreFail='+String(s.restoreFail?'$true':'$false'),
      'function Stop-ScheduledTask {',
      '  param([string]$TaskName)',
      "  if(($stopFail -eq 'broker' -and $TaskName -eq $BrokerTask) -or ($stopFail -eq 'hub' -and $TaskName -eq $BootTask)){throw 'STOP_SYNTHETIC_FAILURE'}",
      '}',
      'function Start-ScheduledTask {',
      '  param([string]$TaskName)',
      "  if(($startFail -eq 'broker' -and $TaskName -eq $BrokerTask) -or ($startFail -eq 'hub' -and $TaskName -eq $BootTask)){throw 'START_SYNTHETIC_FAILURE'}",
      '}',
      'function Restore {if($restoreFail){throw "RESTORE_SYNTHETIC_FAILURE"}}',
      'function Start-Sleep {param([int]$Seconds)}',
      'function Write-Status {param([string]$state,[string]$message);[Console]::WriteLine("STATUS="+$state+";"+$message)}',
      "try {throw 'ORIGINAL_UPDATE_FAILURE'",
      rollback,
    ].join('\r\n');
    const output=run(scriptText);
    assert.equal(output.status,s.code,output.stderr);
    assert.match(output.stdout,new RegExp('STATUS='+s.status+';'));
    assert.match(output.stdout,/ORIGINAL_UPDATE_FAILURE/);
    if(s.stopFail)assert.match(output.stdout,/STOP_SYNTHETIC_FAILURE/);
    if(s.startFail)assert.match(output.stdout,/START_SYNTHETIC_FAILURE/);
    if(s.restoreFail)assert.match(output.stdout,/RESTORE_SYNTHETIC_FAILURE/);
    if(s.status==='rolled_back')assert.doesNotMatch(output.stdout,/rollback_failed/);
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
    assert.equal(output.status,0,output.stderr);
    assert.match(output.stdout,/RESTORE_PASS/);
  }finally{
    rmSync(root,{recursive:true,force:true});
  }
});
