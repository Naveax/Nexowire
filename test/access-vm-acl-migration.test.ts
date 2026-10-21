import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const scriptUrl=new URL('../scripts/acceptance-access-vm-acl-migration.ps1',import.meta.url);
const src=readFileSync(scriptUrl,'utf8');

test('VM ACL migration fixture always requires explicit opt-in and a VM model',()=>{
  assert.match(src,/ACL_VM_EXPLICIT_AUTHORIZATION_REQUIRED/);
  assert.match(src,/ACL_VM_HYPERVISOR_NOT_ATTESTED/);
  assert.match(src,/AuthorizedVmFixture/);
  assert.match(src,/test-isolated-broker-acl-rollback\.ps1/);
  assert.match(src,/ACL_VM_FIXTURE_ROLLBACK_UNVERIFIED/);
  assert.match(src,/productionApproved=\$false/);
  assert.match(src,/installedBrokerAclVerified=\$false/);
  assert.match(src,/uacBypassed=\$false/);
  assert.doesNotMatch(src,/Register-ScheduledTask|Stop-ScheduledTask|Set-Service|Restart-Service|Start-Process.*RunAs|takeown\.exe/);
});

test('non opted-in invocation fails before any temp ACL modification on Windows',{
  skip:process.platform!=='win32',
},()=>{
  const r=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',[
    '-NoLogo','-NoProfile','-NonInteractive','-File',fileURLToPath(scriptUrl),
  ],{
    encoding:'utf8',windowsHide:true,shell:false,
    timeout:10_000,maxBuffer:100_000,
  });
  assert.notEqual(r.status,0);
  assert.match(String(r.stderr)+String(r.stdout),/ACL_VM_EXPLICIT_AUTHORIZATION_REQUIRED/);
  assert.doesNotMatch(String(r.stdout),/ISOLATED_VM_FIXTURE_ONLY/);
});
