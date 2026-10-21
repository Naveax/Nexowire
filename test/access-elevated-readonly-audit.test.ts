import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const file=new URL('../scripts/audit-access-elevated-readonly.ps1',import.meta.url);
const source=readFileSync(file,'utf8');

test('physical source inspector is absolute-path-only, elevated read-only and never production proof',()=>{
  assert.match(source,/ACCESS_READONLY_ELEVATED_OBSERVER_REQUIRED/);
  assert.match(source,/ACCESS_READONLY_HIGH_INTEGRITY_REQUIRED/);
  assert.match(source,/Get-Acl -LiteralPath/);
  assert.match(source,/GetAccessRules\(\$true,\$true/);
  assert.match(source,/NexowireStack/);
  assert.match(source,/privileged-broker/);
  assert.match(source,/sourceCoverageComplete=\$false/);
  assert.match(source,/nativeAccessCheckPerformed=\$false/);
  assert.match(source,/productionApproved=\$false/);
  assert.doesNotMatch(source,/Set-Acl|icacls\.exe|Start-Process.*RunAs|Register-ScheduledTask|Stop-Service|Restart-Service|Start-ScheduledTask|takeown\.exe/);
});

test('unprivileged Work PC must refuse physical elevated attestation without UAC prompt',{
  skip:process.platform!=='win32',
},()=>{
  const run=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',[
    '-NoLogo','-NoProfile','-NonInteractive','-File',fileURLToPath(file),
  ],{windowsHide:true,shell:false,encoding:'utf8',timeout:12000,maxBuffer:200000});
  // If the test runner is already privileged, no fixed target is modified;
  // the source snapshot still always reports productionApproved=false.
  if(run.status===0){
    const data=JSON.parse(run.stdout.trim()) as Record<string,unknown>;
    assert.equal(data.productionApproved,false);
    assert.equal(data.nativeAccessCheckPerformed,false);
    assert.equal(data.aclOrUacOrServiceMutated,false);
  }else{
    assert.match(run.stderr+run.stdout,/ACCESS_READONLY_ELEVATED_OBSERVER_REQUIRED|ACCESS_READONLY_HIGH_INTEGRITY_REQUIRED|ACCESS_READONLY_WINDOWS_ONLY/);
  }
});
