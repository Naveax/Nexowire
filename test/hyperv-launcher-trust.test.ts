import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const run=(launcher:string,runtime:string,signer:string,lh:string,rh:string)=>{
 const x=spawnSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',
   path.resolve('scripts/audit-hyperv-launcher-trust.ps1'),
   '-LauncherPath',launcher,'-RuntimePath',runtime,
   '-ExpectedPublisherThumbprint',signer,
   '-ExpectedLauncherSha256',lh,'-ExpectedRuntimeSha256',rh],
 {encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:16384});
 assert.equal(x.status,0,'Windows trust audit unavailable: '+(x.stderr??'').slice(0,1800));
 return JSON.parse(x.stdout.trim()) as {
  elevatedDispatchEnabled:boolean;productionApproved:boolean;
  releaseManifestSignatureVerified:boolean;installedProcessHandleIdentityVerified:boolean;
  launcher:{signatureStatus:string;signerThumbprint:string;publisherMatches:boolean;independentlyPinnedSha256Matches:boolean;parentBroadWriteGrantFound:boolean|null;installedRunningImageIdentityVerified:boolean;aclProviderError:string;signatureProviderError:string};
  runtime:{signatureStatus:string;publisherMatches:boolean;independentlyPinnedSha256Matches:boolean};
 };
};
test('read-only real Windows Authenticode surrogate cannot authorize Hyper-V elevation', {
 skip:process.platform!=='win32',timeout:35000,
},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nx-hyperv-readonly-'));
 try{
   const actual=path.join(process.env.SystemRoot??'C:\\Windows',
     'System32','WindowsPowerShell','v1.0','powershell.exe');
   const launcher=path.join(dir,'hyperv-test-launcher.exe');
   const runtime=path.join(dir,'hyperv-test-runtime.exe');
   await fs.copyFile(actual,launcher);await fs.copyFile(actual,runtime);
   const lhash=createHash('sha256').update(await fs.readFile(launcher)).digest('hex');
   const rhash=createHash('sha256').update(await fs.readFile(runtime)).digest('hex');
   // Obtain the *observed* native certificate thumbprint from the same
   // fail-closed audit. Do not rely on brittle -Command quoting in hosted CI.
   const initial=run(launcher,runtime,'',lhash,rhash);
   assert.equal(initial.launcher.signatureStatus,'Valid',
     'Windows Authenticode evidence unavailable: '+initial.launcher.signatureProviderError);
   const pinned=initial.launcher.signerThumbprint;
   assert.match(pinned,/^[A-Fa-f0-9]{40}$/);
   const good=run(launcher,runtime,pinned,lhash,rhash);
   assert.equal(good.launcher.signatureStatus,'Valid');
   assert.equal(good.runtime.signatureStatus,'Valid');
   assert.equal(good.launcher.publisherMatches,true);
   assert.equal(good.launcher.independentlyPinnedSha256Matches,true);
   assert.equal(good.runtime.independentlyPinnedSha256Matches,true);
   assert.equal(good.productionApproved,false);
   assert.equal(good.elevatedDispatchEnabled,false);
   assert.equal(good.releaseManifestSignatureVerified,false);
   assert.equal(good.installedProcessHandleIdentityVerified,false);
   assert.equal(good.launcher.installedRunningImageIdentityVerified,false);
   // A fixed SHA token cannot serve as a signed executable or startup proof.
   const replaced=await fs.readFile(launcher);
   replaced.writeUInt8(replaced.readUInt8(replaced.length-1)^1,replaced.length-1);
   await fs.writeFile(launcher,replaced);
   const bad=run(launcher,runtime,pinned,lhash,rhash);
   assert.equal(bad.launcher.independentlyPinnedSha256Matches,false);
   assert.notEqual(bad.launcher.signatureStatus,'Valid');
   assert.equal(bad.elevatedDispatchEnabled,false);
 }finally{await fs.rm(dir,{force:true,recursive:true})}
});

test('test-owned parent Modify ACE is detected without touching ProgramData or real services', {
 skip:process.platform!=='win32',timeout:25000,
},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nx-hyperv-dacl-'));
 try {
   const launcher=path.join(dir,'synthetic-launcher.exe');
   const runtime=path.join(dir,'synthetic-runtime.exe');
   await fs.writeFile(launcher,'unsigned fixture; never execute');
   await fs.writeFile(runtime,'unsigned fixture; never execute');
   const acl=spawnSync('icacls.exe',[dir,'/grant','*S-1-5-11:(OI)(CI)M'],
     {encoding:'utf8',windowsHide:true,timeout:10000});
   assert.equal(acl.status,0,(acl.stderr??'').slice(0,1200));
   const report=run(launcher,runtime,'', '', '');
   assert.equal(report.launcher.parentBroadWriteGrantFound,true, 'ACL provider='+report.launcher.aclProviderError);
   assert.equal(report.productionApproved,false);
   assert.equal(report.elevatedDispatchEnabled,false);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});
