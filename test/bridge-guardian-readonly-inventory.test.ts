import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptFile=new URL('../scripts/inspect-bridge-guardian-readonly.ps1',import.meta.url);
const script=readFileSync(scriptFile,'utf8');

test('Guardian diagnostic pins exact task and only reads Scheduled Tasks',()=>{
  assert.match(script,/Get-ScheduledTask -TaskName \$name -TaskPath/);
  assert.match(script,/Nexowire Bridge Guardian/);
  assert.match(script,/ScheduledTasks\.psd1/);
  assert.doesNotMatch(script,/\b(?:Register|Unregister|Start|Stop|Enable|Disable|Set)-ScheduledTask\b/);
  assert.doesNotMatch(script,/\b(?:icacls\.exe|Set-Acl|Remove-Item|New-Item|Invoke-Expression)\b/i);
  assert.match(script,/privilegedOperationPerformed = \$false/);
});

test('Guardian diagnostic redacts tampered task commands, not credentials or task XML',()=>{
  assert.match(script,/NONCANONICAL/);
  assert.match(script,/safeArguments/);
  assert.match(script,/Resolve-SidBounded/);
  assert.match(script,/lookupVerified = \$false/);
  assert.match(script,/status = 'UNVERIFIED'/);
  assert.doesNotMatch(script,/Export-ScheduledTask|ConvertTo-SecureString|Get-Content|WriteAllText/);
});

test('read-only Windows PowerShell inventory produces bounded audit JSON, not machine changes',{
  skip:process.platform!=='win32',
},()=>{
  const exe='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const result=spawnSync(exe,[
    '-NoLogo','-NoProfile','-NonInteractive',
    '-File',fileURLToPath(scriptFile),
  ],{
    windowsHide:true,encoding:'utf8',timeout:25000,
    maxBuffer:2*1024*1024,
  });
  assert.equal(result.status,0,(result.stderr||result.stdout).slice(0,400));
  const report=JSON.parse(result.stdout.trim()) as {
    auditOnly:boolean;
    privilegedOperationPerformed:boolean;
    installed:boolean;
    lookupVerified:boolean;
    status:string;
    snapshot:unknown;
  };
  assert.equal(report.auditOnly,true);
  assert.equal(report.privilegedOperationPerformed,false);
  assert.equal(typeof report.installed,'boolean');
  assert.equal(typeof report.lookupVerified,'boolean');
  assert.ok(['SNAPSHOT_ONLY','UNVERIFIED','ABSENT','AMBIGUOUS'].includes(report.status));
  if(report.installed){
    assert.equal(report.status,'SNAPSHOT_ONLY');
    assert.ok(report.snapshot);
  }
});
