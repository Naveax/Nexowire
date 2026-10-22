import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// W26 targeted contract-gap witness against #743 exactly. No UAC, ACL edits,
// installed Broker, native importer or user files. This test intentionally
// records CURRENT wrong-type acceptance; it is not a production PASS.
const onlyWindows = process.platform !== 'win32';
const audit = path.resolve('scripts/audit-core-broker-protected-tree.ps1');

type Snapshot = {
  requestInputKind: string;
  requestEnvelopeVersion: number;
  inspectedFilesCount: number;
  signedImportManifestVerified: boolean;
  importListIndependentlyEnumerated: boolean;
  nativeEffectiveLowPrivilegeAccessCheckCompleted: boolean;
  productionReady: boolean;
  elevatedCoreDispatchEnabled: boolean;
};
function invoke(request: Record<string,unknown>) {
  const encoded=Buffer.from(JSON.stringify(request),'utf8').toString('base64');
  const proc=spawnSync('pwsh.exe',[
    '-NoLogo','-NoProfile','-NonInteractive','-File',audit,
    '-EvidenceRequestBase64',encoded,
  ],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:512*1024});
  assert.equal(proc.error,undefined,'PowerShell process launch failed');
  const stdout=(proc.stdout??'').trim();
  return {
    status:proc.status,
    report:proc.status===0?JSON.parse(stdout) as Snapshot:null,
    error:(proc.stderr??'').slice(0,2000),
  };
}

test('W26/#743 strict JSON version must be typed; string and boolean v1 are currently misaccepted', {
  skip:onlyWindows,timeout:120000,
},async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-w26-743-version-'));
  t.after(async()=>fs.rm(temp,{recursive:true,force:true}));
  const root=path.join(temp,'protected');
  const up=path.join(root,'updater'),imports=path.join(root,'imports');
  await fs.mkdir(up,{recursive:true});
  await fs.mkdir(imports,{recursive:true});
  const launcher=path.join(root,'broker.exe'),updater=path.join(up,'updater.exe'),
    imported=path.join(imports,'stage.dll');
  for(const filename of [launcher,updater,imported])
    await fs.writeFile(filename,'DISPOSABLE UNSIGNED QA BYTES NEVER EXECUTE');

  const make=(version:unknown)=>({
    version,protectedInstallRoot:root,launcherPath:launcher,updaterPath:updater,
    importedModulePaths:[imported],
  });
  const canonical=invoke(make(1));
  assert.equal(canonical.status,0,canonical.error);
  assert.equal(canonical.report?.requestEnvelopeVersion,1);
  assert.equal(canonical.report?.requestInputKind,'envelope-v1-readonly');
  assert.equal(canonical.report?.inspectedFilesCount,3);
  assert.equal(canonical.report?.productionReady,false);
  assert.equal(canonical.report?.signedImportManifestVerified,false);
  assert.equal(canonical.report?.importListIndependentlyEnumerated,false);
  assert.equal(canonical.report?.nativeEffectiveLowPrivilegeAccessCheckCompleted,false);
  assert.equal(canonical.report?.elevatedCoreDispatchEnabled,false);

  // Source contract gap: PowerShell's '-cne 1' coerces a JSON string and
  // boolean into the numeric comparison, rather than validating JSON types.
  // A schema-correcting owner change SHOULD make these exit nonzero; this
  // witness deliberately records the current broken v1 strict-type behavior.
  for(const [label,version] of [['string "1"','1'],['boolean true',true]] as const){
    const result=invoke(make(version));
    assert.equal(result.status,0,
      'known wrong-type version currently accepted: '+label+' '+result.error);
    assert.equal(result.report?.requestInputKind,'envelope-v1-readonly',label);
    assert.equal(result.report?.requestEnvelopeVersion,1,label);
    assert.equal(result.report?.productionReady,false,label);
    assert.equal(result.report?.elevatedCoreDispatchEnabled,false,label);
  }

  // Controls: unsupported numeric version and unexpected fields are already
  // rejected. The bug is NARROW, in type validation of allowed v1.
  assert.notEqual(invoke(make(2)).status,0,'future version must be rejected');
  assert.notEqual(invoke({...make(1),untrustedExtra:'x'}).status,0,
    'unknown JSON fields must be rejected');
});
