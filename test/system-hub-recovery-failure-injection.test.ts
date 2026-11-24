import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {SYSTEM_HUB_RECOVERY_PS} from '../scripts/ai04-controlled-system-hub-cutover.js';

const psQuote=(value:string):string=>"'"+value.replaceAll("'","''")+"'";
const powershell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function executeIsolatedRecoveryFailureInjection(mode:'pre-stop'|'late-shutdown-write'|'tampered-launcher'|'late-launcher-swap'|'boot-action-swapped'|'boot-action-swapped-no-write'|'late-write-after-unregister',phase:'SYSTEM_STARTED'|'AWAITING_PHYSICAL_ACCEPTANCE'|'UNRECOGNIZED'|'complete'|'rolled_back'='SYSTEM_STARTED'):void{
  const temp=mkdtempSync(path.join(os.tmpdir(),'ai04-fi-'));
  try{
    const source=path.join(temp,'legacy');
    const target=path.join(temp,'system');
    const recovery=path.join(temp,'recovery');
    mkdirSync(source);mkdirSync(target);mkdirSync(recovery);
    const sourceFile=path.join(source,'record.txt');
    const targetFile=path.join(target,'record.txt');
    writeFileSync(sourceFile,'legacy-state','utf8');
    writeFileSync(targetFile,['late-shutdown-write','late-launcher-swap','boot-action-swapped','boot-action-swapped-no-write','late-write-after-unregister'].includes(mode)?'legacy-state':'new-system-data','utf8');
    const launcherFile=path.join(temp,'legacy-launch.ps1');
    const originalLauncher='# synthetic user-Hub launcher\\n';
    writeFileSync(launcherFile,originalLauncher,'utf8');
    writeFileSync(path.join(recovery,'original-user-launcher.ps1'),originalLauncher,'utf8');
    const launcherSha256=createHash('sha256').update(originalLauncher,'utf8').digest('hex');
    if(mode==='tampered-launcher')writeFileSync(launcherFile,'# changed launcher\\n','utf8');
    const marker='synthetic-owner-marker';
    const journal={version:1,host:process.env.COMPUTERNAME??os.hostname(),
      phase,marker,port:43110,sourceRoot:source,
      launcherPath:launcherFile,launcherSha256,
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
      '$script:fakeBoot=[pscustomobject]@{TaskName='+psQuote('Nexowire Hub Boot')+';TaskPath='+psQuote('\\')+';Principal=[pscustomobject]@{UserId='+psQuote('SYSTEM')+
        '};Description='+psQuote(marker)+';Actions=@([pscustomobject]@{Execute='+
        psQuote(powershell)+';Arguments='+psQuote(taskAction)+'})}',
      'function Get-ScheduledTask { [CmdletBinding()] param([string]$TaskName,[string]$TaskPath); return $script:fakeBoot }',
      'function Stop-ScheduledTask { [CmdletBinding()] param([string]$TaskName,[string]$TaskPath); $script:stopCount++;'+
        (mode==='late-shutdown-write'
          ?' Set-Content -LiteralPath '+psQuote(targetFile)+" -Value 'late-system-write' -Encoding Ascii -NoNewline;"
          :mode==='late-launcher-swap'
            ?' Set-Content -LiteralPath '+psQuote(launcherFile)+" -Value '# after-stop replacement' -Encoding Ascii -NoNewline;"
            :mode==='boot-action-swapped'
              ?' Set-Content -LiteralPath '+psQuote(targetFile)+" -Value 'late-system-write' -Encoding Ascii -NoNewline; $script:fakeBoot.Actions[0].Execute='untrusted.exe';"
              :mode==='boot-action-swapped-no-write'
                ?" $script:fakeBoot.Actions[0].Execute='untrusted.exe';"
                :'')+' }',
      'function Start-ScheduledTask { [CmdletBinding()] param([string]$TaskName,[string]$TaskPath); $script:resumeCount++ }',
      'function Unregister-ScheduledTask { [CmdletBinding()] param([string]$TaskName,[string]$TaskPath,[switch]$Confirm); $script:removeCount++;'+
        (mode==='late-write-after-unregister'
          ?' Set-Content -LiteralPath '+psQuote(targetFile)+" -Value 'late-system-write' -Encoding Ascii -NoNewline;"
          :'')+' }',
      'function Get-NetTCPConnection { [CmdletBinding()] param([string]$State); return @() }',
      ...(phase==='AWAITING_PHYSICAL_ACCEPTANCE'?[
        'function Start-Sleep { [CmdletBinding()] param([int]$Milliseconds) }',
        'function Get-Date { [CmdletBinding()] param();$script:dateCalls++;return [datetime]::UtcNow.AddMinutes($script:dateCalls) }',
      ]:[]),
      'foreach($name in @("Get-ScheduledTask","Stop-ScheduledTask","Start-ScheduledTask","Unregister-ScheduledTask","Get-NetTCPConnection")){'+
        'if((Get-Command $name -ErrorAction Stop).CommandType -ne "Function"){throw "AI04_FIXTURE_UNSAFE_COMMAND"}}',
      '$body=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('+
        psQuote(Buffer.from(body,'utf8').toString('base64'))+'))',
      '$failure=$null',
      'try{& ([scriptblock]::Create($body))}catch{$failure=$_.Exception.Message}',
      'if(-not $failure){throw "AI04_EXPECTED_RECOVERY_REJECTION"}',
      'if($script:stopCount -ne '+(['late-shutdown-write','late-launcher-swap','boot-action-swapped','boot-action-swapped-no-write','late-write-after-unregister'].includes(mode)?'1':'0')+
        ' -or $script:resumeCount -ne '+(['late-shutdown-write','late-launcher-swap'].includes(mode)?'1':'0')+
        ' -or $script:removeCount -ne '+(mode==='late-write-after-unregister'?'1':'0')+'){'+
        'throw ("AI04_UNEXPECTED_MUTATIONS: stop="+$script:stopCount+" resume="+$script:resumeCount+" remove="+$script:removeCount+" reason="+$failure)}',
      'if($failure -notmatch "'+(['UNRECOGNIZED','complete','rolled_back'].includes(phase)
        ?'AI04_RECOVERY_UNKNOWN_PHASE'
        :mode==='boot-action-swapped'
          ?'AI04_RECOVERY_SYSTEM_RESUME_FAILED'
        :mode==='boot-action-swapped-no-write'
          ?'AI04_RECOVERY_RESUME_ACTION_CHANGED'
        :['tampered-launcher','late-launcher-swap'].includes(mode)
          ?'AI04_RECOVERY_LEGACY_LAUNCHER_CHANGED'
          :'AI04_ROLLBACK_UNRECONCILED_SYSTEM_WRITES')+'"){throw ("AI04_WRONG_REJECTION: "+$failure)}',
      'Write-Output ("AI04_SIMULATED_REJECTION "+$failure)',
    ];
    // EncodedCommand can exceed the Windows CreateProcess command-line limit
    // as the real recovery script grows. Keep the *same* isolated fixture
    // contents but execute from a disposable file instead.
    const fixtureScript=path.join(temp,'run-isolated-recovery.ps1');
    writeFileSync(fixtureScript,setup.join('\r\n'),'utf8');
    const result=spawnSync(powershell,
      ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
        '-File',fixtureScript],
      {encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:512*1024});
    assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
    assert.match(result.stdout,/AI04_SIMULATED_REJECTION/);
    assert.equal(readFileSync(sourceFile,'utf8'),'legacy-state');
    assert.equal(readFileSync(targetFile,'utf8'),
      ['late-shutdown-write','boot-action-swapped','late-write-after-unregister'].includes(mode)?'late-system-write':['late-launcher-swap','boot-action-swapped-no-write'].includes(mode)?'legacy-state':'new-system-data');
    assert.equal(JSON.parse(readFileSync(journalFile,'utf8')).phase,phase);
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

test('provisional SYSTEM Hub with divergent writes never returns to legacy',
  {skip:process.platform!=='win32'},()=>{
    executeIsolatedRecoveryFailureInjection('pre-stop','AWAITING_PHYSICAL_ACCEPTANCE');
  });
test('modified user launcher denies fallback before stopping either task',
  {skip:process.platform!=='win32'},()=>{
    executeIsolatedRecoveryFailureInjection('tampered-launcher');
  });

test('late launcher replacement after SYSTEM shutdown resumes verified SYSTEM task',
  {skip:process.platform!=='win32'},()=>{
    executeIsolatedRecoveryFailureInjection('late-launcher-swap');
  });

test('unknown recovery journal phase causes zero task mutations',
  {skip:process.platform!=='win32'},()=>{
    executeIsolatedRecoveryFailureInjection('pre-stop','UNRECOGNIZED');
  });

test('modified recovery task action after shutdown cannot be resumed',
  {skip:process.platform!=='win32'},()=>{
    executeIsolatedRecoveryFailureInjection('boot-action-swapped');
  });

test('replaced SYSTEM task action after stop prevents task removal even when state matches',
  {skip:process.platform!=='win32'},()=>{
    executeIsolatedRecoveryFailureInjection('boot-action-swapped-no-write');
  });

test('late SYSTEM write after unregister refuses to start stale user Hub',
  {skip:process.platform!=='win32'},()=>{
    executeIsolatedRecoveryFailureInjection('late-write-after-unregister');
  });

test('noncanonical terminal journal phases never silently report recovery success',
  {skip:process.platform!=='win32'},()=>{
    executeIsolatedRecoveryFailureInjection('pre-stop','complete');
    executeIsolatedRecoveryFailureInjection('pre-stop','rolled_back');
  });
