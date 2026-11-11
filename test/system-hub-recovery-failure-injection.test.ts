import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {SYSTEM_HUB_RECOVERY_PS} from '../scripts/ai04-controlled-system-hub-cutover.js';

const psQuote=(value:string):string=>"'"+value.replaceAll("'","''")+"'";
const powershell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function executeIsolatedRecoveryFailureInjection(mode:'pre-stop'|'late-shutdown-write'):void{
  const temp=mkdtempSync(path.join(os.tmpdir(),'ai04-fi-'));
  try{
    const source=path.join(temp,'legacy');
    const target=path.join(temp,'system');
    const recovery=path.join(temp,'recovery');
    mkdirSync(source);mkdirSync(target);mkdirSync(recovery);
    const sourceFile=path.join(source,'record.txt');
    const targetFile=path.join(target,'record.txt');
    writeFileSync(sourceFile,'legacy-state','utf8');
    writeFileSync(targetFile,mode==='pre-stop'?'new-system-data':'legacy-state','utf8');
    const marker='synthetic-owner-marker';
    const journal={version:1,host:process.env.COMPUTERNAME??os.hostname(),
      phase:'SYSTEM_STARTED',marker,port:43110,sourceRoot:source,
      originalUserPrincipal:'EXAMPLE\\test',createdAt:new Date().toISOString()};
    const journalFile=path.join(recovery,'journal.json');
    writeFileSync(journalFile,JSON.stringify(journal),'utf8');

    // Redirect *both* hard-coded protected paths into a disposable temp tree.
    // This is deliberately not an elevated or physical cutover test.
    const sourceRootLiteral="$root='C:\\ProgramData\\Nexowire\\hub-cutover-recovery'";
    const systemStateLiteral="$target='C:\\ProgramData\\Nexowire\\hub-state'";
    assert.equal(SYSTEM_HUB_RECOVERY_PS.split(sourceRootLiteral).length,2);
    assert.equal(SYSTEM_HUB_RECOVERY_PS.split(systemStateLiteral).length,2);
    const body=SYSTEM_HUB_RECOVERY_PS
      .replace(sourceRootLiteral,'$root='+psQuote(recovery))
      .replace(systemStateLiteral,'$target='+psQuote(target));

    const taskAction='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\\ProgramData\\Nexowire\\hub-boot\\launch.ps1"';
    const setup=[
      "$ErrorActionPreference='Stop'",
      '$script:stopCount=0;$script:resumeCount=0;$script:removeCount=0',
      '$script:fakeBoot=[pscustomobject]@{Principal=[pscustomobject]@{UserId='+psQuote('SYSTEM')+
        '};Description='+psQuote(marker)+';Actions=@([pscustomobject]@{Execute='+
        psQuote(powershell)+';Arguments='+psQuote(taskAction)+'})}',
      'function Get-ScheduledTask { [CmdletBinding()] param([string]$TaskName,[string]$TaskPath); return $script:fakeBoot }',
      'function Stop-ScheduledTask { [CmdletBinding()] param([string]$TaskName,[string]$TaskPath); $script:stopCount++;'+
        (mode==='late-shutdown-write'
          ?' Set-Content -LiteralPath '+psQuote(targetFile)+" -Value 'late-system-write' -Encoding Ascii -NoNewline;"
          :'')+' }',
      'function Start-ScheduledTask { [CmdletBinding()] param([string]$TaskName,[string]$TaskPath); $script:resumeCount++ }',
      'function Unregister-ScheduledTask { [CmdletBinding()] param([string]$TaskName,[string]$TaskPath,[switch]$Confirm); $script:removeCount++ }',
      'function Get-NetTCPConnection { [CmdletBinding()] param([string]$State); return @() }',
      'foreach($name in @("Get-ScheduledTask","Stop-ScheduledTask","Start-ScheduledTask","Unregister-ScheduledTask","Get-NetTCPConnection")){'+
        'if((Get-Command $name -ErrorAction Stop).CommandType -ne "Function"){throw "AI04_FIXTURE_UNSAFE_COMMAND"}}',
      '$body=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('+
        psQuote(Buffer.from(body,'utf8').toString('base64'))+'))',
      '$failure=$null',
      'try{& ([scriptblock]::Create($body))}catch{$failure=$_.Exception.Message}',
      'if(-not $failure){throw "AI04_EXPECTED_RECOVERY_REJECTION"}',
      'if($script:stopCount -ne '+(mode==='pre-stop'?'0':'1')+
        ' -or $script:resumeCount -ne '+(mode==='pre-stop'?'0':'1')+
        ' -or $script:removeCount -ne 0){'+
        'throw ("AI04_UNEXPECTED_MUTATIONS: stop="+$script:stopCount+" resume="+$script:resumeCount+" remove="+$script:removeCount+" reason="+$failure)}',
      'if($failure -notmatch "AI04_ROLLBACK_UNRECONCILED_SYSTEM_WRITES"){throw ("AI04_WRONG_REJECTION: "+$failure)}',
      'Write-Output ("AI04_SIMULATED_REJECTION "+$failure)',
    ];
    const result=spawnSync(powershell,
      ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
        Buffer.from(setup.join('\r\n'),'utf16le').toString('base64')],
      {encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:512*1024});
    assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
    assert.match(result.stdout,/AI04_SIMULATED_REJECTION/);
    assert.equal(readFileSync(sourceFile,'utf8'),'legacy-state');
    assert.equal(readFileSync(targetFile,'utf8'),
      mode==='pre-stop'?'new-system-data':'late-system-write');
    assert.equal(JSON.parse(readFileSync(journalFile,'utf8')).phase,'SYSTEM_STARTED');
  }finally{rmSync(temp,{recursive:true,force:true})}
}

test('synthetic SYSTEM writes before recovery preserve the active task',
  {skip:process.platform!=='win32'},()=>{
    executeIsolatedRecoveryFailureInjection('pre-stop');
  });
test('synthetic SYSTEM shutdown writes trigger task resume, never legacy fallback',
  {skip:process.platform!=='win32'},()=>{
    executeIsolatedRecoveryFailureInjection('late-shutdown-write');
  });
