import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const fixtureUrl=new URL('../scripts/test-isolated-broker-acl-rollback.ps1',import.meta.url);
const source=readFileSync(fixtureUrl,'utf8');
const pinnedPowerShell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

test('fixture scope cannot accept a live broker, Guardian, task or arbitrary target',()=>{
  assert.match(source,/param\(\[switch\]\$SimulateFailure\)/);
  assert.match(source,/\[IO\.Path\]::GetTempPath\(\)/);
  assert.match(source,/nexowire-acl-fixture-/);
  assert.match(source,/\[guid\]::NewGuid\(\)/);
  assert.match(source,/NOT_AN_ISOLATED_TEMP_FIXTURE/);
  assert.match(source,/originalAclRestored=\$restored/);
  assert.match(source,/productionAccepted=\$false/);
  assert.match(source,/serviceOrTaskTouched=\$false/);
  assert.doesNotMatch(source,/Stop-ScheduledTask|Start-ScheduledTask|Register-ScheduledTask|Stop-Service|Restart-Service/);
});

for(const failure of [false,true]){
  test('Windows isolated ACL setup and rollback: '+(failure?'injected failure':'normal'),{
    skip:process.platform!=='win32',
  },()=>{
    const run=spawnSync(pinnedPowerShell,[
      '-NoLogo','-NoProfile','-NonInteractive',
      '-File',fileURLToPath(fixtureUrl),
      ...(failure?['-SimulateFailure']:[]),
    ],{
      windowsHide:true,shell:false,encoding:'utf8',
      timeout:20_000,maxBuffer:1024*1024,
      // Windows ACL APIs may require a complete interactive user profile.
      // The script itself pins icacls.exe and has no caller-controlled target.
      env:{...process.env,PATH:'C:\\Windows\\System32;C:\\Windows'},
    });
    assert.equal(run.status,0,'fixture ACL test did not confirm rollback: '+String(run.stdout).slice(0,600)+' '+String(run.stderr).slice(0,150));
    const result=JSON.parse(run.stdout.trim()) as Record<string,unknown>;
    assert.equal(result.status,failure?'simulated-failure':'isolated-hardened');
    assert.equal(result.reproducedBroadModify,true);
    assert.equal(result.broadModifyAfterHardening,failure?true:false);
    assert.equal(result.originalAclRestored,true);
    assert.equal(result.restoreRootOk,true);
    assert.equal(result.restoreFileOk,true);
    assert.equal(result.rootAclMatched,true);
    assert.equal(result.fileAclMatched,true);
    assert.equal(result.fixtureRemoved,true);
    assert.equal(result.productionAclModified,false);
    assert.equal(result.productionAccepted,false);
    assert.equal(result.serviceOrTaskTouched,false);
  });
}
