import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {promises as fs, realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * #17 independent cross-head compatibility probe for #709.
 * Does not replace #705/#681 test bytes or any #03 owner implementation.
 * Windows operations affect only generated temporary CI fixtures.
 */
type NativeEntry={
  path:string;isDirectory:boolean;evidenceAvailable:boolean;
  providerError:string;
  aclProtected:boolean|null;
  broadLowTrustWriteFound:boolean|null;
  reparsePointDetected:boolean|null;
};
type NativeTree={
  inputsInsideRoot:boolean;
  rejectedOutOfRootPaths:string[];
  acceptedInputPaths:string[];
  inspectedEntries:NativeEntry[];
  inspectedFilesCount:number;
  allInspectedPathsHaveAclEvidence:boolean;
  anyInspectedPathUnsafe:boolean;
  importListIndependentlyEnumerated:false;
  signedImportManifestVerified:false;
  updaterReleaseRollbackVerified:false;
  publisherOfEveryImportVerified:false;
  protectedCompleteImageTreeAttested:false;
  pidCreationFiletimeVerified:false;
  processDupHandleBoundaryVerified:false;
  elevatedCoreDispatchEnabled:false;
  productionReady:false;
};
const audit=path.resolve('scripts/audit-core-broker-protected-tree.ps1');
function encode(root:string,exe:string,updater:string,imports:string[]):string{
  return Buffer.from(JSON.stringify({
    version:1,
    protectedInstallRoot:root,
    launcherPath:exe,
    updaterPath:updater,
    importedModulePaths:imports,
  }),'utf8').toString('base64');
}
function observe(envelope:string):{code:number|null;stdout:string;stderr:string}{
  const proc=spawnSync('pwsh.exe',[
    '-NoProfile','-NonInteractive','-File',audit,
    '-EvidenceRequestBase64',envelope,
  ],{encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:128*1024});
  return {code:proc.status,stdout:proc.stdout??'',stderr:proc.stderr??''};
}
function inspect(root:string,exe:string,updater:string,imports:string[]):NativeTree{
  const p=observe(encode(root,exe,updater,imports));
  assert.equal(p.code,0,'native read-only audit failed: '+p.stderr.slice(0,1400));
  return JSON.parse(p.stdout.trim()) as NativeTree;
}
async function fixture(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-qa17-709-crosshead-'));
  const protectedRoot=path.join(root,'protected');
  const imports=path.join(protectedRoot,'imports');
  const updaterDir=path.join(protectedRoot,'updater');
  await fs.mkdir(imports,{recursive:true});
  await fs.mkdir(updaterDir,{recursive:true});
  const exe=path.join(protectedRoot,'broker.exe');
  const imp=path.join(imports,'native.dll');
  const updater=path.join(updaterDir,'updater.exe');
  await Promise.all([fs.writeFile(exe,'UNSIGNED QA EXE NEVER EXECUTE'),
    fs.writeFile(imp,'UNSIGNED QA IMPORT NEVER LOAD'),
    fs.writeFile(updater,'UNSIGNED QA UPDATER NEVER EXECUTE')]);
  return {root,protectedRoot,imports,updaterDir,exe,imp,updater};
}
function canonical(p:string):string{return realpathSync.native(p).toLowerCase()}
function stillNoBroker(report:NativeTree){
  assert.equal(report.importListIndependentlyEnumerated,false);
  assert.equal(report.signedImportManifestVerified,false);
  assert.equal(report.publisherOfEveryImportVerified,false);
  assert.equal(report.updaterReleaseRollbackVerified,false);
  assert.equal(report.protectedCompleteImageTreeAttested,false);
  assert.equal(report.pidCreationFiletimeVerified,false);
  assert.equal(report.processDupHandleBoundaryVerified,false);
  assert.equal(report.elevatedCoreDispatchEnabled,false);
  assert.equal(report.productionReady,false);
}

test('#17 cross-head #709 captures actual native EXE/import/updater/ancestor evidence with canonical file identity',{
  skip:process.platform!=='win32',timeout:30000,
},async()=>{
  const f=await fixture();
  try{
    const r=inspect(f.protectedRoot,f.exe,f.updater,[f.imp]);
    assert.equal(r.inputsInsideRoot,true);
    assert.equal(r.inspectedFilesCount,3);
    assert.equal(r.acceptedInputPaths.length,4);
    assert.equal(r.allInspectedPathsHaveAclEvidence,true,
      'unknown ACL must not be treated as safe: '+JSON.stringify(r));
    for(const p of [f.exe,f.imp,f.updater,f.protectedRoot,f.imports,f.updaterDir]){
      const hit=r.inspectedEntries.find(x=>canonical(x.path)===canonical(p));
      assert.ok(hit,'missing native file/ancestor '+p+': '+JSON.stringify(r));
      assert.equal(hit.evidenceAvailable,true,'ACL provider UNAVAILABLE on '+p);
      assert.notEqual(hit.broadLowTrustWriteFound,null,'unknown writeability on '+p);
    }
    stillNoBroker(r);
  }finally{await fs.rm(f.root,{recursive:true,force:true})}
});

test('#17 cross-head #709 inherited Authenticated Users Modify on import ancestor is unsafe, not missing provider',{
  skip:process.platform!=='win32',timeout:30000,
},async()=>{
  const f=await fixture();
  try{
    const a=spawnSync('icacls.exe',[
      f.imports,'/grant','*S-1-5-11:(OI)(CI)M',
    ],{encoding:'utf8',windowsHide:true,timeout:8000,maxBuffer:4096});
    assert.equal(a.status,0,'test-only temporary ACL fixture: '+a.stderr);
    const r=inspect(f.protectedRoot,f.exe,f.updater,[f.imp]);
    const impDir=r.inspectedEntries.find(x=>canonical(x.path)===canonical(f.imports));
    assert.ok(impDir,'missing import ancestor '+JSON.stringify(r));
    assert.equal(impDir.evidenceAvailable,true,'real ACL provider not working');
    assert.equal(impDir.broadLowTrustWriteFound,true);
    assert.equal(r.anyInspectedPathUnsafe,true);
    stillNoBroker(r);
  }finally{await fs.rm(f.root,{recursive:true,force:true})}
});

test('#17 cross-head #709 provider UNAVAILABLE on absent DLL has null ACL, not forged false',{
  skip:process.platform!=='win32',timeout:25000,
},async()=>{
  const f=await fixture();
  try{
    const missing=path.join(f.imports,'does-not-exist.dll');
    const r=inspect(f.protectedRoot,f.exe,f.updater,[missing]);
    // Windows runner temp is named RUNNER~1 by Node but GetFullPath reports
    // runneradmin. Canonicalize the existing parent, NOT the missing file.
    const missingCanonical=path.join(
      realpathSync.native(path.dirname(missing)),path.basename(missing)
    ).toLowerCase();
    const hit=r.inspectedEntries.find(x=>x.path.toLowerCase()===missingCanonical);
    assert.ok(hit,'missing file must produce an explicit observation '+JSON.stringify(r));
    assert.equal(hit.evidenceAvailable,false);
    assert.equal(hit.broadLowTrustWriteFound,null);
    assert.equal(hit.aclProtected,null);
    assert.notEqual(hit.providerError,'');
    assert.equal(r.allInspectedPathsHaveAclEvidence,false);
    stillNoBroker(r);
  }finally{await fs.rm(f.root,{recursive:true,force:true})}
});

test('#17 cross-head #709 rejects escaped updater and incomplete import inventory without production acceptance',{
  skip:process.platform!=='win32',timeout:25000,
},async()=>{
  const f=await fixture();
  try{
    const outside=path.join(f.root,'replacement-updater.exe');
    await fs.writeFile(outside,'TEST UPDATER NEVER EXECUTE');
    const escaped=inspect(f.protectedRoot,f.exe,outside,[f.imp]);
    assert.equal(escaped.inputsInsideRoot,false);
    assert.ok(escaped.rejectedOutOfRootPaths.some(p=>canonical(p)===canonical(outside)),
      'escaped updater should be rejected '+JSON.stringify(escaped));
    stillNoBroker(escaped);
    const omitted=inspect(f.protectedRoot,f.exe,f.updater,[f.imp]);
    assert.equal(omitted.importListIndependentlyEnumerated,false,
      'caller-declared import list cannot prove import closure');
    stillNoBroker(omitted);
    for(const tampered of [
      Buffer.from(JSON.stringify({
        version:1,protectedInstallRoot:f.protectedRoot,
        launcherPath:f.exe,updaterPath:f.updater,
        importedModulePaths:[f.imp],unknownField:'force valid',
      })).toString('base64'),
      Buffer.from(JSON.stringify({
        version:1,protectedInstallRoot:f.protectedRoot,
        launcherPath:f.exe,updaterPath:f.updater,
        importedModulePaths:[],
      })).toString('base64'),
    ]){
      const refused=observe(tampered);
      assert.notEqual(refused.code,0,'malformed envelope must fail closed');
      assert.match(refused.stdout+refused.stderr,/BROKER_TREE_REQUEST_SCHEMA_INVALID/);
    }
  }finally{await fs.rm(f.root,{recursive:true,force:true})}
});

test('#17 cross-head #709 caller forged Authenticode Valid cannot mask an unsigned staged image',{
  skip:process.platform!=='win32',timeout:25000,
},async()=>{
  const f=await fixture();
  try{
    const escaped=(x:string)=>x.replace(/'/g,"''");
    const src=path.resolve('scripts/audit-windows-job-helper-trust.ps1');
    const cmd=[
      "function Get-AuthenticodeSignature { [pscustomobject]@{Status='Valid';SignerCertificate=[pscustomobject]@{Thumbprint='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'}} }",
      "function Get-Acl { [pscustomobject]@{AreAccessRulesProtected=$true;Access=@()} }",
      "& '"+escaped(src)+"' -HelperPath '"+escaped(f.exe)+"'",
    ].join('; ');
    const p=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command',cmd],
      {encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:128*1024});
    assert.equal(p.status,0,'read-only helper failed: '+p.stderr.slice(0,1000));
    const x=JSON.parse(p.stdout.trim()) as {
      authenticodeStatus:string;publisherValid:boolean;
      authenticodeEvidenceAvailable:boolean;aclEvidenceAvailable:boolean;
      broadWriteGrantFound:boolean|null;parentBroadWriteGrantFound:boolean|null;
      productionReady:boolean;provisionalFileTrustChecksPassed:boolean;
    };
    assert.notEqual(x.authenticodeStatus,'Valid','forged caller function was accepted');
    assert.equal(x.publisherValid,false);
    assert.equal(x.provisionalFileTrustChecksPassed,false);
    assert.equal(x.productionReady,false);
    if(!x.aclEvidenceAvailable){
      assert.equal(x.broadWriteGrantFound,null);
      assert.equal(x.parentBroadWriteGrantFound,null);
    }
  }finally{await fs.rm(f.root,{recursive:true,force:true})}
});
