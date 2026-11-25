import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {SYSTEM_HUB_RECOVERY_PS} from '../scripts/ai04-controlled-system-hub-cutover.js';

const ps='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
function quote(s:string):string{return "'"+s.replaceAll("'","''")+"'";}

function isolatedProvisionalRecovery(mode:'healthy'|'delayed-healthy'|'foreign-sid'):void{
  const root=mkdtempSync(path.join(os.tmpdir(),'ai07-provisional-recovery-'));
  try{
    const source=path.join(root,'source'),target=path.join(root,'target'),recovery=path.join(root,'recovery');
    mkdirSync(source);mkdirSync(target);mkdirSync(recovery);
    writeFileSync(path.join(source,'data.txt'),'legacy');
    writeFileSync(path.join(target,'data.txt'),'legacy');
    const marker='synthetic-ai07-provisional-owner';
    const journal={version:1,host:process.env.COMPUTERNAME??os.hostname(),
      phase:'AWAITING_PHYSICAL_ACCEPTANCE',marker,port:43110,sourceRoot:source,
      originalUserPrincipal:'DESKTOP\\test',createdAt:'2026-11-11T10:00:00Z'};
    const journalFile=path.join(recovery,'journal.json');
    writeFileSync(journalFile,JSON.stringify(journal));
    const rootLiteral="$root='C:\\ProgramData\\Nexowire\\hub-cutover-recovery'";
    const targetLiteral="$target='C:\\ProgramData\\Nexowire\\hub-state'";
    assert.equal(SYSTEM_HUB_RECOVERY_PS.split(rootLiteral).length,2);
    assert.equal(SYSTEM_HUB_RECOVERY_PS.split(targetLiteral).length,2);
    const body=SYSTEM_HUB_RECOVERY_PS
      .replace(rootLiteral,'$root='+quote(recovery))
      .replace(targetLiteral,'$target='+quote(target));
    const taskAction='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\\ProgramData\\Nexowire\\hub-boot\\launch.ps1"';
    const setup=[
      "$ErrorActionPreference='Stop'",
      '$script:stop=0;$script:unregister=0;$script:enable=0;$script:start=0;$script:probe=0;$script:requests=0',
      '$script:mode='+quote(mode),
      '$script:boot=[pscustomobject]@{State="Running";Description='+quote(marker)+
        ';Principal=[pscustomobject]@{UserId="SYSTEM"};Actions=@([pscustomobject]@{Execute='+
        quote(ps)+';Arguments='+quote(taskAction)+'})}',
      'function Get-ScheduledTask { [CmdletBinding()] param([string]$TaskName,[string]$TaskPath);return $script:boot }',
      'function Get-NetTCPConnection { [CmdletBinding()] param([string]$State);$script:probe++;'+
        'if($script:mode -eq "delayed-healthy" -and $script:probe -eq 1){return @()};'+
        'return [pscustomobject]@{LocalPort=43110;OwningProcess=4242} }',
      'function Get-CimInstance { [CmdletBinding()] param([string]$ClassName,[string]$Filter);'+
        'return [pscustomobject]@{ProcessId=4242} }',
      'function Invoke-CimMethod { [CmdletBinding()] param([object]$InputObject,[string]$MethodName);'+
        'if($MethodName -ne "GetOwnerSid"){throw "BAD_FAKE_CIM_METHOD"};'+
        'if($script:mode -eq "foreign-sid"){return [pscustomobject]@{Sid="S-1-5-21-555"}};'+
        'return [pscustomobject]@{Sid="S-1-5-18"} }',
      'function Invoke-WebRequest { [CmdletBinding()] param([string]$Uri,[switch]$UseBasicParsing,[int]$TimeoutSec);'+
        '$script:requests++;return [pscustomobject]@{StatusCode=200} }',
      'function Stop-ScheduledTask { [CmdletBinding()] param([string]$TaskName,[string]$TaskPath);$script:stop++;throw "MUTATION_DENIED" }',
      'function Start-ScheduledTask { [CmdletBinding()] param([string]$TaskName,[string]$TaskPath);$script:start++;throw "MUTATION_DENIED" }',
      'function Enable-ScheduledTask { [CmdletBinding()] param([string]$TaskName,[string]$TaskPath);$script:enable++;throw "MUTATION_DENIED" }',
      'function Unregister-ScheduledTask { [CmdletBinding()] param([string]$TaskName,[string]$TaskPath,[switch]$Confirm);$script:unregister++;throw "MUTATION_DENIED" }',
      'function Start-Sleep { [CmdletBinding()] param([int]$Milliseconds);return }',
      '$expectedFunctions=@("Get-ScheduledTask","Get-NetTCPConnection","Get-CimInstance","Invoke-CimMethod",'+
        '"Invoke-WebRequest","Stop-ScheduledTask","Start-ScheduledTask","Enable-ScheduledTask","Unregister-ScheduledTask","Start-Sleep")',
      'foreach($name in $expectedFunctions){if((Get-Command $name -ErrorAction Stop).CommandType -ne "Function"){throw "UNSAFE_FAKE_COMMAND"}}',
      '$body=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('+
        quote(Buffer.from(body).toString('base64'))+'))',
      '$failure=$null',
      'try{& ([scriptblock]::Create($body)) | Out-Null}catch{$failure=$_.Exception.Message}',
      'if($script:stop -ne 0 -or $script:unregister -ne 0 -or $script:start -ne 0 -or $script:enable -ne 0){'+
        'throw ("PROVISIONAL_UNEXPECTED_MUTATION stop="+$script:stop+" unreg="+$script:unregister)}',
      mode==='foreign-sid'
        ? 'if($failure -cne "AI07_PROVISIONAL_PORT_OWNER_UNTRUSTED" -or $script:requests -ne 0){throw ("AI07_BAD_FAIL_CLOSED "+$failure)}'
        : 'if($failure -or $script:requests -ne 1){throw ("AI07_HEALTHY_PROVISIONAL_REJECTED "+$failure)}',
      mode==='delayed-healthy'
        ? 'if($script:probe -ne 2){throw "AI07_STARTUP_GRACE_NOT_USED"}'
        : 'if($script:probe -ne 1){throw "AI07_PROBE_COUNT_MISMATCH"}',
      'Write-Output "AI07_PROVISIONAL_TEST_PASS"',
    ];
    const fixtureFile=path.join(root,'safe-recovery-harness.ps1');
    writeFileSync(fixtureFile,setup.join('\r\n'),'utf8');
    const run=spawnSync(ps,['-NoLogo','-NoProfile','-NonInteractive','-File',fixtureFile],{
      encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:512*1024
    });
    assert.equal(run.status,0,JSON.stringify({error:run.error?.message,signal:run.signal,stderr:run.stderr,stdout:run.stdout}));
    assert.match(run.stdout,/AI07_PROVISIONAL_TEST_PASS/);
    assert.equal(JSON.parse(readFileSync(journalFile,'utf8')).phase,'AWAITING_PHYSICAL_ACCEPTANCE');
    assert.equal(readFileSync(path.join(target,'data.txt'),'utf8'),'legacy');
  }finally{rmSync(root,{recursive:true,force:true});}
}

test('healthy provisional SYSTEM Hub stays online; no recovery task mutation',
  {skip:process.platform!=='win32'},()=>{
  isolatedProvisionalRecovery('healthy');
});
test('startup trigger tolerates brief listener absence before confirmed SYSTEM health',
  {skip:process.platform!=='win32'},()=>{
  isolatedProvisionalRecovery('delayed-healthy');
});
test('foreign listener SID fails closed before HTTP or task mutation',
  {skip:process.platform!=='win32'},()=>{
  isolatedProvisionalRecovery('foreign-sid');
});
test('recovery schedule uses a bounded 15-minute recurring guard',()=>{
  const source=readFileSync(new URL('../scripts/ai04-controlled-system-hub-cutover.ts',import.meta.url),'utf8');
  assert.match(source,/RepetitionInterval \(New-TimeSpan -Minutes 15\)/);
  assert.match(source,/RepetitionDuration \(New-TimeSpan -Days 365\)/);
});