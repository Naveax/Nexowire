import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';

const path = resolve('scripts/broker-handoff-preflight.ps1');
const script = readFileSync(path, 'utf8');

test('isolated maintenance preflight never mutates protected Windows services or tasks',()=>{
  assert.match(script, /safeToChangeProcesses = \$false/);
  assert.match(script, /actionsPerformed = 'READ_ONLY'/);
  assert.match(script, /AUTHENTICATED_ELEVATED_TASK_AND_ROLLBACK_NOT_YET_VERIFIED/);
  assert.match(script, /Get-NetTCPConnection/);
  assert.match(script, /Get-FileHash/);
  assert.match(script, /Get-ScheduledTaskInfo/);
  assert.match(script, /Get-RouteCode \$BrokerPort/);
  assert.match(script, /distinctHubAndBrokerPids/);
  assert.match(script, /legacySupervisorWillAvoidRespawnWhenTaskPresent/);
  assert.match(script, /stagedWindowsBundleChecksumMatches/);
  assert.match(script, /stagedArchiveChecksumMatches/);
  assert.match(script, /\[Parameter\(Mandatory=\$true\)\].*\$ExpectedVersion/);
  assert.match(script, /Get-VerifiedRelease \('nexowire-' \+ \$ExpectedVersion \+ '\.tgz'\)/);
  assert.doesNotMatch(script, /nexowire-1\.0\.5\.tgz|broker-stage-v105/);
  assert.match(script, /stagedVersionMatchesExpected/);
  assert.match(script, /stagedPublisherSignatureVerified = \$false/);
  assert.match(script, /rollbackChainVerified = \$false/);
  for(const text of [
    'Stop-Process', 'Start-Process', 'Stop-ScheduledTask', 'Start-ScheduledTask',
    'Unregister-ScheduledTask', 'Register-ScheduledTask', 'Set-ScheduledTask',
    'Restart-Service', 'Start-Service', 'Stop-Service', 'Remove-Item',
    'Invoke-Expression', 'Start-Job', 'Set-Item',
  ]) {
    assert.equal(script.includes(text),false, 'Mutating command not permitted: '+text);
  }
  assert.doesNotMatch(script, /\$env:(?:.+?TOKEN|.+?SECRET)|Get-Content[^\r\n]*\.dpapi\.json/i);
});

test('hardened report does not grant elevated authority from unauthenticated 401 response',()=>{
  assert.match(script, /Get-RouteCode/);
  assert.match(script, /unauthenticatedHealthStatus/);
  assert.match(script, /safeToChangeProcesses = \$false/);
  assert.doesNotMatch(script, /safeToChangeProcesses = \$true/);
});

test('PowerShell parser accepts maintenance preflight without executing it',{
  skip:process.platform!=='win32',
},()=>{
  const ps = [
    '$file=' + "'" + path.replaceAll("'", "''") + "';",
    '$errors=$null; $tokens=$null;',
    '[System.Management.Automation.Language.Parser]::ParseFile(',
    '$file, [ref]$tokens, [ref]$errors) | Out-Null;',
    'if($errors.Count -gt 0) {',
    '$errors | ForEach-Object { Write-Error $_.Message }; exit 5',
    '}'
  ].join(' ');
  const result = execFileSync('powershell.exe',[
    '-NoProfile','-NonInteractive','-Command',ps,
  ],{encoding:'utf8',timeout:15000,windowsHide:true});
  assert.equal(result.trim(),'');
});


test('Windows handoff binds staged archive and manifest to explicit release version without granting cutover',{
  skip:process.platform!=='win32',timeout:45000,
},async()=>{
  const scratch=await mkdtemp(join(os.tmpdir(),'nxw-versioned-handoff-'));
  try{
    const archive=Buffer.from('synthetic-archive-NOT-an-installable-Nexowire-release');
    await writeFile(join(scratch,'nexowire-1.0.8.tgz'),archive);
    const digest=createHash('sha256').update(archive).digest('hex');
    await writeFile(join(scratch,'SHA256SUMS'),digest+'  nexowire-1.0.8.tgz\n');
    const moduleDir=join(scratch,'package','dist','src','agent');
    await mkdir(moduleDir,{recursive:true});
    await writeFile(join(scratch,'package','package.json'),JSON.stringify({version:'1.0.8'}));
    await writeFile(join(moduleDir,'privileged-broker.js'),"const route='/health';");
    const inspect=(version:string)=>JSON.parse(execFileSync('powershell.exe',[
      '-NoLogo','-NoProfile','-NonInteractive','-File',path,
      '-ExpectedVersion',version,'-Staging',scratch,
    ],{encoding:'utf8',windowsHide:true,timeout:18000,maxBuffer:200000}));
    const accepted=inspect('1.0.8');
    assert.equal(accepted.expectedReleaseVersion,'1.0.8');
    assert.equal(accepted.stagedArchiveChecksumMatches,true);
    assert.equal(accepted.stagedVersionMatchesExpected,true);
    assert.equal(accepted.stagedPublisherSignatureVerified,false);
    assert.equal(accepted.rollbackChainVerified,false);
    assert.equal(accepted.safeToChangeProcesses,false);
    assert.equal(accepted.actionsPerformed,'READ_ONLY');
    const mismatched=inspect('1.0.7');
    assert.equal(mismatched.stagedArchiveChecksumMatches,false);
    assert.equal(mismatched.stagedVersionMatchesExpected,false);
    assert.equal(mismatched.safeToChangeProcesses,false);
  }finally{
    await rm(scratch,{recursive:true,force:true});
  }
});
