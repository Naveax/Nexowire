import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
type Report={productionReady:false;elevatedDispatchEnabled:false;
 fullTransitiveImportInventoryVerified:false;separateLowPrivilegeTokenBoundaryVerified:false;
 paths:Array<{path:string;actualCurrentTokenAccess:Record<string,string>;
 listedAclAvailable:boolean;inheritedAndExplicitAceCount:number}>};
const script=path.resolve('scripts/audit-core-broker-fixture-effective-access.ps1');
function inspect(root:string,targets:Array<{path:string;isDirectory:boolean}>):Report {
 const b64=Buffer.from(JSON.stringify(targets),'utf8').toString('base64');
 const r=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',script,
 '-FixtureRoot',root,'-TargetsBase64',b64],
 {encoding:'utf8',windowsHide:true,timeout:22000,maxBuffer:128*1024});
 assert.equal(r.status,0,'native Windows current-token provider: '+(r.stderr??'').slice(0,1800));
 return JSON.parse(r.stdout.trim()) as Report;
}
test('actual CreateFileW(OPEN_EXISTING) verifies synthetic EXE and import/updater ancestor access', {
 skip:process.platform!=='win32',timeout:40000,
},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx03-os-effective-'));
 const temporaryDeniedDll=path.join(root,'imports','transitive.dll');
 const temporaryImportsDirectory=path.join(root,'imports');
 try{
  await fs.writeFile(path.join(root,'.nx03-synthetic-acl-fixture'),'NX03_SOURCE_ONLY');
  const imports=path.join(root,'imports'),updates=path.join(root,'updater');
  await fs.mkdir(imports);await fs.mkdir(updates);
  const exe=path.join(root,'helper.exe'),dll=path.join(imports,'transitive.dll'),
   updater=path.join(updates,'update.exe');
  for(const p of [exe,dll,updater])await fs.writeFile(p,'SYNTHETIC TEST ONLY');
  const targets=[{path:exe,isDirectory:false},{path:dll,isDirectory:false},
   {path:updater,isDirectory:false},{path:imports,isDirectory:true},
   {path:updates,isDirectory:true},{path:root,isDirectory:true}];
  const before=inspect(root,targets);
  assert.equal(before.paths.length,6);
  for(const p of before.paths){
   assert.equal(p.listedAclAvailable,true);
   assert.ok(p.inheritedAndExplicitAceCount>=1);
   assert.ok(Object.values(p.actualCurrentTokenAccess).every(x=>
    x==='ALLOW'||x==='DENIED'||x.startsWith('UNKNOWN_')));
  }
  assert.equal(before.paths[1]?.actualCurrentTokenAccess.writeData,'ALLOW',
   'test owner must initially have effective file write access');
  const acl=spawnSync('icacls.exe',[dll,'/deny','*S-1-5-11:(W)'],
   {encoding:'utf8',windowsHide:true,timeout:9000,maxBuffer:8192});
  assert.equal(acl.status,0,'fixture-only explicit deny '+(acl.stderr??''));
  const denied=inspect(root,targets);
  assert.equal(denied.paths[1]?.actualCurrentTokenAccess.writeData,'DENIED',
   'real OS effective access must reject explicit deny, not merely DACL text');
  const directoryAcl=spawnSync('icacls.exe',[imports,'/deny','*S-1-5-11:(WD)'],
    {encoding:'utf8',windowsHide:true,timeout:9000,maxBuffer:8192});
  assert.equal(directoryAcl.status,0,'fixture-only directory deny '+(directoryAcl.stderr??''));
  const deniedDirectory=inspect(root,targets);
  assert.equal(deniedDirectory.paths[3]?.actualCurrentTokenAccess.addFile,'DENIED',
    'real OS must also reject ADD_FILE on low-trust writable import ancestor');
  assert.equal(denied.productionReady,false);
  assert.equal(denied.elevatedDispatchEnabled,false);
  assert.equal(denied.separateLowPrivilegeTokenBoundaryVerified,false);
  assert.equal(denied.fullTransitiveImportInventoryVerified,false);
 }finally{
  // Undo ONLY this test-owned synthetic denial before removing the fixture.
  for(const fixturePath of [temporaryDeniedDll,temporaryImportsDirectory]){
   spawnSync('icacls.exe',[fixturePath,'/remove:d','*S-1-5-11'],
     {encoding:'utf8',windowsHide:true,timeout:7000});
  }
  await fs.rm(root,{recursive:true,force:true});
 }
});
test('effective ACL provider rejects any real/installed path without TEMP ownership marker', {
 skip:process.platform!=='win32',timeout:20000,
},async()=>{
 const arg=Buffer.from(JSON.stringify([{path:'C:\\Windows\\explorer.exe',isDirectory:false}]))
  .toString('base64');
 const bad=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',script,
  '-FixtureRoot','C:\\Windows','-TargetsBase64',arg],
  {encoding:'utf8',windowsHide:true,timeout:9000});
 assert.notEqual(bad.status,0);
 assert.match((bad.stderr??'')+(bad.stdout??''),/ONLY_TEST_OWNED_TEMP_FIXTURE_ALLOWED/);
});
