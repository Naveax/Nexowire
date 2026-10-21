import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {promises as fs,realpathSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

type Item={
 path:string;isDirectory:boolean;evidenceAvailable:boolean;
 broadLowTrustWriteFound:boolean|null;reparsePointDetected:boolean|null;
};
type Audit={
 productionReady:false;elevatedCoreDispatchEnabled:false;
 inputsInsideRoot:boolean;rejectedOutOfRootPaths:string[];
 acceptedInputPaths:string[];inspectedFilesCount:number;
 inspectedEntries:Item[];allInspectedPathsHaveAclEvidence:boolean;
 anyInspectedPathUnsafe:boolean;importListIndependentlyEnumerated:false;
 signedImportManifestVerified:false;updaterReleaseRollbackVerified:false;
 publisherOfEveryImportVerified:false;protectedCompleteImageTreeAttested:false;
 pidCreationFiletimeVerified:false;processDupHandleBoundaryVerified:false;
};
function inspect(root:string,exe:string,updater:string,imports:string[]):Audit {
 const envelope=Buffer.from(JSON.stringify({
  version:1,protectedInstallRoot:root,launcherPath:exe,
  updaterPath:updater,importedModulePaths:imports,
 }), 'utf8').toString('base64');
 const p=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',
   path.resolve('scripts/audit-core-broker-protected-tree.ps1'),
   '-EvidenceRequestBase64',envelope],
   {encoding:'utf8',windowsHide:true,timeout:14000,maxBuffer:128*1024});
 assert.equal(p.status,0,'audit script failed '+(p.stderr??'').slice(0,1700));
 const result=JSON.parse(p.stdout.trim()) as Audit;
 assert.ok(Array.isArray(result.inspectedEntries),'inspectedEntries not an array');
 return result;
}
const canonical=(value:string)=>realpathSync.native(value).toLowerCase();
async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-core-protected-tree-'));
 const parent=path.join(root,'protected');
 const nested=path.join(parent,'imports');
 const updates=path.join(parent,'updater');
 await fs.mkdir(nested,{recursive:true});await fs.mkdir(updates,{recursive:true});
 const exe=path.join(parent,'broker.exe'),updater=path.join(updates,'updater.exe'),
  modulePath=path.join(nested,'native.dll');
 await Promise.all([fs.writeFile(exe,'synthetic unsigned broker - NEVER EXECUTE'),
  fs.writeFile(updater,'synthetic unsigned updater - NEVER EXECUTE'),
  fs.writeFile(modulePath,'synthetic unsigned import - NEVER EXECUTE')]);
 return {root,parent,exe,updater,modulePath};
}
test('every declared import and updater ancestor is inspected, not merely the Broker EXE', {
 skip:process.platform!=='win32',timeout:26000,
},async()=>{
 const f=await fixture();
 try{
  const a=inspect(f.parent,f.exe,f.updater,[f.modulePath]);
  assert.equal(a.inputsInsideRoot,true,JSON.stringify(a));
  assert.equal(a.inspectedFilesCount,3,JSON.stringify(a));
  assert.equal(a.acceptedInputPaths.length,4,JSON.stringify(a));
  for(const p of [f.exe,f.updater,f.modulePath,f.parent,
   path.dirname(f.modulePath),path.dirname(f.updater)]){
   assert.ok(a.inspectedEntries.some(e=>e.evidenceAvailable && canonical(e.path)===canonical(p)),
    'missing actual EXE/import/updater ACL or ancestor '+p+'; report='+JSON.stringify(a));
  }
  assert.equal(a.allInspectedPathsHaveAclEvidence,true);
  assert.equal(a.importListIndependentlyEnumerated,false);
  assert.equal(a.signedImportManifestVerified,false);
  assert.equal(a.updaterReleaseRollbackVerified,false);
  assert.equal(a.protectedCompleteImageTreeAttested,false);
  assert.equal(a.productionReady,false);
  assert.equal(a.elevatedCoreDispatchEnabled,false);
 }finally{await fs.rm(f.root,{recursive:true,force:true})}
});
test('replaced unsigned import, forged manifest and out-of-root updater never become accepted', {
 skip:process.platform!=='win32',timeout:28000,
},async()=>{
 const f=await fixture();
 try{
  const external=path.join(f.root,'outside-updater.exe');
  await fs.writeFile(external,'malicious replacement fixture never run');
  const a=inspect(f.parent,f.exe,external,[f.modulePath]);
  assert.equal(a.inputsInsideRoot,false);
  assert.ok(a.rejectedOutOfRootPaths.some(x=>canonical(x)===canonical(external)),JSON.stringify(a));
  assert.equal(a.productionReady,false);
  await fs.writeFile(f.modulePath,'REPLACED UNSIGNED MODULE WITH SAME NAME');
  await fs.writeFile(path.join(f.parent,'manifest.sha256'),
   '0'.repeat(64)+'  '+path.basename(f.modulePath)+'\n');
  const b=inspect(f.parent,f.exe,f.updater,[f.modulePath]);
  assert.equal(b.inputsInsideRoot,true);
  assert.equal(b.publisherOfEveryImportVerified,false);
  assert.equal(b.signedImportManifestVerified,false);
  assert.equal(b.protectedCompleteImageTreeAttested,false);
 }finally{await fs.rm(f.root,{recursive:true,force:true})}
});
test('low-trust Modify inherited on imported module parent is discovered', {
 skip:process.platform!=='win32',timeout:28000,
},async()=>{
 const f=await fixture();
 try{
  const folder=path.dirname(f.modulePath);
  const change=spawnSync('icacls.exe',[folder,'/grant','*S-1-5-11:(OI)(CI)M'],
     {encoding:'utf8',windowsHide:true,timeout:8000});
  assert.equal(change.status,0,'test-only folder ACE: '+change.stderr);
  const a=inspect(f.parent,f.exe,f.updater,[f.modulePath]);
  const e=a.inspectedEntries.find(x=>canonical(x.path)===canonical(folder));
  assert.ok(e,'import directory must be inspected: '+JSON.stringify(a));
  assert.equal(e.broadLowTrustWriteFound,true,JSON.stringify({entry:e,entries:a.inspectedEntries}));
  assert.equal(a.anyInspectedPathUnsafe,true);
  assert.equal(a.productionReady,false);
 }finally{await fs.rm(f.root,{recursive:true,force:true})}
});
test('absent import evidence is UNKNOWN and never a clean tree', {
 skip:process.platform!=='win32',timeout:26000,
},async()=>{
 const f=await fixture();
 try{
  const missing=path.join(f.parent,'imports','missing.dll');
  const a=inspect(f.parent,f.exe,f.updater,[missing]);
  assert.equal(a.allInspectedPathsHaveAclEvidence,false);
  assert.equal(a.protectedCompleteImageTreeAttested,false);
  assert.equal(a.processDupHandleBoundaryVerified,false);
 }finally{await fs.rm(f.root,{recursive:true,force:true})}
});
