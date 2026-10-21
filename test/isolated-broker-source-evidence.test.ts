import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const fixture=new URL('../scripts/test-isolated-broker-source-evidence.ps1',import.meta.url);
const script=readFileSync(fixture,'utf8');

test('source evidence uses only new random temporary data, never production source',()=>{
  assert.match(script,/\[IO\.Path\]::GetTempPath\(\)/);
  assert.match(script,/nwx-source-evidence-/);
  assert.match(script,/INHERITED_UNSAFE_ACL_NOT_OBSERVED/);
  assert.match(script,/Get-AuthenticodeSignature/);
  assert.match(script,/AuthenticatedUsersModifyDetected/);
  assert.match(script,/sourceSnapshotMismatchDenied/);
  assert.match(script,/productionAccepted=\$false/);
  assert.match(script,/productionFileTouched=\$false/);
  assert.doesNotMatch(script,/Register-ScheduledTask|Start-ScheduledTask|Stop-ScheduledTask|Stop-Service|Set-Service|Restart-Service/);
});

test('real Windows isolated inherited ACL, parent/updater/binary mutation and unsigned EXE deny',{
  skip:process.platform!=='win32',
},()=>{
  const result=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',[
    '-NoLogo','-NoProfile','-NonInteractive','-File',fileURLToPath(fixture),
  ],{
    windowsHide:true,shell:false,encoding:'utf8',
    timeout:20_000,maxBuffer:1024*1024,
    env:{...process.env,PATH:'C:\\Windows\\System32;C:\\Windows'},
  });
  assert.equal(result.status,0,
    'isolated negative source audit failed: '+String(result.stdout).slice(0,500)+' '+String(result.stderr).slice(0,150));
  const data=JSON.parse(result.stdout.trim()) as Record<string,unknown>;
  assert.equal(data.scope,'isolated-temp-only');
  for(const key of [
    'inheritedAuthenticatedUsersModifyDetected',
    'parentWritableDetected',
    'childDaclInherited',
    'updaterModifiedDetected',
    'launcherModifiedDetected',
    'binaryReplacedDetected',
    'unsignedBinaryDenied',
    'otherValidPublisherRejected',
    'sourceSnapshotMismatchDenied',
    'fixtureRemoved',
  ]){
    assert.equal(data[key],true,key);
  }
  for(const key of ['signerIdentityPinned','productionAccepted','productionFileTouched']){
    assert.equal(data[key],false,key);
  }
});
