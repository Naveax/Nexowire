import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script=path.resolve('scripts/audit-core-broker-protected-tree.ps1');
type Report={requestEnvelopeVersion:number;requestInputKind:string;
  inspectedFilesCount:number;allInspectedPathsHaveAclEvidence:boolean;
  productionReady:false;elevatedCoreDispatchEnabled:false;
  signedImportManifestVerified:false;transitiveImportsIndependentlyEnumerated:false;
  nativeEffectiveLowPrivilegeAccessCheckCompleted:false};
function invokeJson(json:string){
 const encoded=Buffer.from(json,'utf8').toString('base64');
 const p=spawnSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',
  script,'-EvidenceRequestBase64',encoded],
  {encoding:'utf8',windowsHide:true,timeout:16000,maxBuffer:128*1024});
 return {status:p.status,stderr:p.stderr??'',
  report:p.status===0?JSON.parse(p.stdout.trim()) as Report:null};
}
test('QA26 bug: strict literal JSON numeric version 1 only; string/bool/double cannot coerce', {
 skip:process.platform!=='win32',timeout:105000,
},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx03-strict-v1-'));
 try{
  const protectedRoot=path.join(root,'protected');
  const imports=path.join(protectedRoot,'imports'),updates=path.join(protectedRoot,'updater');
  await fs.mkdir(imports,{recursive:true});
  await fs.mkdir(updates,{recursive:true});
  const launcher=path.join(protectedRoot,'broker.exe'),updater=path.join(updates,'updater.exe'),
   dll=path.join(imports,'import.dll');
  for(const f of [launcher,updater,dll])await fs.writeFile(f,'SYNTHETIC UNSIGNED QA ONLY');
  const envelope={version:1,protectedInstallRoot:protectedRoot,
   launcherPath:launcher,updaterPath:updater,importedModulePaths:[dll]};
  const canonical=invokeJson(JSON.stringify(envelope));
  assert.equal(canonical.status,0,canonical.stderr);
  assert.equal(canonical.report?.requestInputKind,'envelope-v1-readonly');
  assert.equal(canonical.report?.requestEnvelopeVersion,1);
  assert.equal(canonical.report?.inspectedFilesCount,3);
  assert.equal(canonical.report?.allInspectedPathsHaveAclEvidence,true);
  assert.equal(canonical.report?.productionReady,false);
  assert.equal(canonical.report?.elevatedCoreDispatchEnabled,false);
  assert.equal(canonical.report?.transitiveImportsIndependentlyEnumerated,false);
  const invalidVersions=[
   '"1"','true','false','null','"01"','1.0','1e0','1E+0','1.1','2','0','-1','{}','[]'
  ];
  for(const literal of invalidVersions){
   const raw=JSON.stringify({...envelope,version:1}).replace('"version":1',
    '"version":'+literal);
   const result=invokeJson(raw);
   assert.notEqual(result.status,0,'unsupported JSON version '+literal+' was accepted');
   assert.match(result.stderr,/BROKER_TREE_REQUEST_SCHEMA_INVALID/,
    'wrong-type version '+literal+' must fail closed before ACL inspection');
   assert.equal(result.report,null);
  }
  for(const invalid of [true,123,null,{},['nested'],false]){
   const result=invokeJson(JSON.stringify({...envelope,importedModulePaths:[invalid]}));
   assert.notEqual(result.status,0,'malformed imported module path was coerced: '+JSON.stringify(invalid));
   assert.match(result.stderr,/BROKER_TREE_REQUEST_SCHEMA_INVALID/);
  }
  const extra=invokeJson(JSON.stringify({...envelope,remoteApproved:true}));
  assert.notEqual(extra.status,0);
  assert.match(extra.stderr,/BROKER_TREE_REQUEST_SCHEMA_INVALID/);
  // Historical QA17/QA19 WindowsPowerShell -File interface must still
  // invoke this same fail-closed ACL code without JSON coercion.
  const legacy=spawnSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',
   script,'-ProtectedInstallRoot',protectedRoot,
   '-LauncherPath',launcher,'-UpdaterPath',updater,
   '-ImportedModulePaths',dll],
   {encoding:'utf8',windowsHide:true,timeout:16000,maxBuffer:128*1024});
  assert.equal(legacy.status,0,'legacy interface broken '+(legacy.stderr??''));
  const previous=JSON.parse(legacy.stdout.trim()) as Report;
  assert.equal(previous.requestInputKind,'legacy-named-readonly');
  assert.equal(previous.inspectedFilesCount,3);
  assert.equal(previous.productionReady,false);
  assert.equal(previous.signedImportManifestVerified,false);
 }finally{
  await fs.rm(root,{recursive:true,force:true});
 }
});
