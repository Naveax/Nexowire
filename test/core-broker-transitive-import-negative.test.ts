import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {promises as fs, realpathSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

interface Entry {
 path:string;evidenceAvailable:boolean;broadLowTrustWriteFound:boolean|null;
}
interface Report {
 inspectedFilesCount:number;inspectedEntries:Entry[];
 allInspectedPathsHaveAclEvidence:boolean;anyInspectedPathUnsafe:boolean;
 importListIndependentlyEnumerated:false;transitiveImportsIndependentlyEnumerated:false;
 nativeEffectiveLowPrivilegeAccessCheckCompleted:false;
 signedImportManifestVerified:false;protectedCompleteImageTreeAttested:false;
 productionReady:false;elevatedCoreDispatchEnabled:false;
}
function audit(root:string,launcher:string,updater:string,imports:string[]):Report{
 const args=Buffer.from(JSON.stringify({
  version:1,protectedInstallRoot:root,launcherPath:launcher,
  updaterPath:updater,importedModulePaths:imports,
 }), 'utf8').toString('base64');
 const result=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',
  path.resolve('scripts/audit-core-broker-protected-tree.ps1'),
  '-EvidenceRequestBase64',args],
  {windowsHide:true,encoding:'utf8',timeout:16000,maxBuffer:256*1024});
 assert.equal(result.status,0,(result.stderr??'').slice(0,1200));
 return JSON.parse(result.stdout.trim()) as Report;
}
test('native ACL observes nested transitive import and updater chain, including inherited Modify', {
 skip:process.platform!=='win32',timeout:40000,
},async()=>{
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'nx-core-transitive-'));
 try{
  const root=path.join(temporary,'protected');
  const imports=path.join(root,'imports');
  const nested=path.join(imports,'second-level');
  const update=path.join(root,'updater');
  await Promise.all([fs.mkdir(nested,{recursive:true}),fs.mkdir(update,{recursive:true})]);
  const launcher=path.join(root,'broker.exe'),updater=path.join(update,'updater.exe');
  const first=path.join(imports,'first.dll'),second=path.join(nested,'dependency.dll');
  for(const f of [launcher,updater,first,second])
   await fs.writeFile(f,'SYNTHETIC UNSIGNED NEVER EXECUTE');
  const grant=spawnSync('icacls.exe',[nested,'/grant','*S-1-5-11:(OI)(CI)M'],
   {encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:4096});
  assert.equal(grant.status,0,'fixture-only ACE: '+(grant.stderr??''));
  const seen=audit(root,launcher,updater,[first,second]);
  assert.equal(seen.inspectedFilesCount,4);
  assert.equal(seen.allInspectedPathsHaveAclEvidence,true);
  const byName=(p:string)=>seen.inspectedEntries.find(e=>
   realpathSync.native(e.path).toLowerCase()===realpathSync.native(p).toLowerCase());
  for(const file of [launcher,updater,first,second,imports,nested,update]){
   const entry=byName(file);
   assert.ok(entry,'missing native ACL evidence '+file);
   assert.equal(entry.evidenceAvailable,true);
  }
  assert.equal(byName(nested)?.broadLowTrustWriteFound,true);
  assert.equal(seen.anyInspectedPathUnsafe,true);
  assert.equal(seen.transitiveImportsIndependentlyEnumerated,false);
  assert.equal(seen.nativeEffectiveLowPrivilegeAccessCheckCompleted,false);
  assert.equal(seen.protectedCompleteImageTreeAttested,false);
  assert.equal(seen.productionReady,false);
  assert.equal(seen.elevatedCoreDispatchEnabled,false);
  // A *caller omitted* transitive dependency cannot be silently declared
  // complete simply because all listed paths were inspected.
  const incomplete=audit(root,launcher,updater,[first]);
  assert.equal(incomplete.inspectedFilesCount,3);
  assert.equal(incomplete.importListIndependentlyEnumerated,false);
  assert.equal(incomplete.transitiveImportsIndependentlyEnumerated,false);
  assert.equal(incomplete.signedImportManifestVerified,false);
  assert.equal(incomplete.productionReady,false);
 }finally{await fs.rm(temporary,{recursive:true,force:true})}
});
test('missing transitive import is UNKNOWN evidence, never an accepted Broker tree', {
 skip:process.platform!=='win32',timeout:28000,
},async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nx-core-transitive-missing-'));
 try{
  const launcher=path.join(directory,'broker.exe');
  const updater=path.join(directory,'updater.exe');
  await fs.writeFile(launcher,'SYNTHETIC');
  await fs.writeFile(updater,'SYNTHETIC');
  const missing=path.join(directory,'missing-import.dll');
  const report=audit(directory,launcher,updater,[missing]);
  assert.equal(report.allInspectedPathsHaveAclEvidence,false);
  assert.equal(report.protectedCompleteImageTreeAttested,false);
  assert.equal(report.nativeEffectiveLowPrivilegeAccessCheckCompleted,false);
  assert.equal(report.productionReady,false);
 }finally{await fs.rm(directory,{recursive:true,force:true})}
});
