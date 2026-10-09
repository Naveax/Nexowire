import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

const script=path.resolve('scripts/rehearse-isolated-scheduled-task-restore.ps1');
const content=readFileSync(script,'utf8');
const ps='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function fixtureTaskCount():number {
  const cmd="$x=@(Get-ScheduledTask -TaskName 'Nexowire-P0-Restore-Fixture-*' -ErrorAction SilentlyContinue);Write-Output $x.Count";
  const r=spawnSync(ps,['-NoProfile','-NonInteractive','-Command',cmd],{
    encoding:'utf8',shell:false,windowsHide:true,timeout:15000,
  });
  assert.equal(r.status,0,r.stderr+' '+r.stdout);
  return Number(r.stdout.trim());
}

test('isolated restore never targets production task, Hub, Broker or service secrets',()=>{
  assert.ok(content.includes("'Nexowire-P0-Restore-Fixture-'"));
  assert.ok(content.includes("[Guid]::NewGuid().ToString('N')"));
  assert.ok(content.includes('FIXTURE_RESTORE_UNEXPECTED_ARGUMENTS'));
  assert.ok(content.includes('New-ScheduledTaskSettingsSet -Disable -Hidden'));
  assert.ok(content.includes("if(@($task.Triggers|Where-Object {$null -ne $_}).Count -ne 0)"));
  assert.ok(content.includes('CurrentUser'));
  assert.ok(content.includes('ProtectedData]::Protect'));
  assert.ok(content.includes('ProtectedData]::Unprotect'));
  assert.ok(content.includes('Unregister-ScheduledTask'));
  assert.ok(content.includes('Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Xml $restoredXml'));
  assert.ok(content.includes('fixtureTaskExecuted=$false'));
  assert.ok(content.includes('restoredRealStack=$false'));
  assert.ok(content.includes('protectedCredentialsRestored=$false'));
  assert.ok(content.includes('safeToCutover=$false'));
  assert.ok(content.includes('productionTaskChanged=$false'));
  assert.ok(!content.includes("'Nexowire Stack'"));
  assert.doesNotMatch(content,/\bStart-ScheduledTask\b|\bEnable-ScheduledTask\b|\bSet-Acl\b|\bicacls(?:\.exe)?\b/);
  assert.ok(!content.includes("'-TaskName'"));
});
test('fixture refuses user-selected task name without creating anything',{
  skip:process.platform!=='win32',
},()=>{
  const before=fixtureTaskCount();
  const run=spawnSync(ps,['-NoProfile','-NonInteractive','-File',script,'-TaskName','Nexowire Stack'],{
    encoding:'utf8',shell:false,windowsHide:true,timeout:25000,
  });
  assert.notEqual(run.status,0);
  assert.equal(fixtureTaskCount(),before);
});
test('CurrentUser DPAPI and real disabled Task Scheduler fixture restoration roundtrip',{
  skip:process.platform!=='win32',
},()=>{
  const before=fixtureTaskCount();
  const run=spawnSync(ps,['-NoProfile','-NonInteractive','-File',script],{
    encoding:'utf8',shell:false,windowsHide:true,timeout:65000,
  });
  if(run.status!==0 && (run.stdout+run.stderr).includes('FIXTURE_RESTORE_UNELEVATED_USER_REQUIRED')){
    // A CI runner elevated as Administrator cannot produce ordinary-user proof.
    assert.equal(fixtureTaskCount(),before);
    return;
  }
  assert.equal(run.status,0,run.stderr+' '+run.stdout);
  const data=JSON.parse(run.stdout);
  assert.equal(data.schemaVersion,1);
  assert.equal(data.mode,'ISOLATED_DISABLED_TASK_FIXTURE');
  for(const field of ['dpapiCurrentUserRoundtrip','taskSchedulerXmlRestored',
    'fixtureDisabled','fixtureHadNoTriggers','fixtureRemovedAfterTest']){
    assert.equal(data[field],true,field);
  }
  for(const field of ['fixtureTaskExecuted','restoredRealStack','protectedCredentialsRestored',
    'productionTaskChanged','productionFilesChanged','authorizedToElevate','safeToCutover']){
    assert.equal(data[field],false,field);
  }
  assert.equal(fixtureTaskCount(),before);
});
