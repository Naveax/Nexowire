import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createWindowsProtectedTransferPublisher,canonicalProtectedTransferPath} from '../../src/agent/windows-protected-transfer-publisher.js';
import {ProtectedTransferReceiptStore} from '../../src/agent/protected-transfer-receipt-store.js';
import {NativeTransferPublisher,verifyNativeTransferReceipt,type NativeTransferAdmission} from '../../src/agent/native-transfer-publisher.js';
import {hardenWindowsProgramDataAcl,verifyWindowsPrivateAcl,protectedWindowsAclEnvironment} from '../../src/security/windows-programdata-acl.js';
import type {LargeTransferBinding,LargeTransferIntent} from '../../src/mcp/durable-large-transfer.js';
const run=promisify(execFile);
const hosted=process.platform==='win32'&&process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted';
test('missing protected Windows runtime cannot create a publisher or elevate',async()=>{
  await assert.rejects(createWindowsProtectedTransferPublisher({} as Parameters<typeof createWindowsProtectedTransferPublisher>[0]),/PROTECTED_BOOTSTRAP_REQUIRED/);
});
test('protected target path rejects reserved devices, invalid characters and noncanonical roots',()=>{
  const root='C:\\ProgramData\\Nexowire\\target\\';
  assert.equal(canonicalProtectedTransferPath(root+'artifact.bin'),root+'artifact.bin');
  for(const name of ['CON','CONIN$','CONOUT$.txt','COM¹.log','LPT²','COM9','NUL.txt','bad?name','bad*name','bad<name','bad>name','bad|name','bad"name','bad:name','trailing.','trailing ','..\\escape.bin','sub/escape.bin','bad\x01name']){
    assert.throws(()=>canonicalProtectedTransferPath(root+name),/WINDOWS_TRANSFER_PATH_DENIED/,JSON.stringify(name));
  }
  for(const name of ['D:\\ProgramData\\file','C:\\Users\\file','\\\\server\\share\\file','C:\\ProgramData\\target\\','C:relative'])assert.throws(()=>canonicalProtectedTransferPath(name),/WINDOWS_TRANSFER_PATH_DENIED/);
});
test('Windows hosted NTFS fixture: actual volume flush, private roots, no-overwrite publication and original signed receipt reopen',
  {timeout:180000,skip:hosted?false:'Requires disposable elevated GitHub-hosted Windows runner; no live-host volume flush'},async t=>{
  const root=path.win32.join('C:\\ProgramData','Nexowire-AI07-fixture-'+randomUUID());
  await fs.mkdir(root,{recursive:false});
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const opts={cwd:'C:\\Windows\\System32',env:protectedWindowsAclEnvironment(),windowsHide:true,timeout:30000,maxBuffer:16384};
  const privateDir=async(dir:string)=>{
    await run('C:\\Windows\\System32\\icacls.exe',[dir,'/setowner','*S-1-5-32-544'],opts);
    hardenWindowsProgramDataAcl(dir);verifyWindowsPrivateAcl(dir);
  };
  await privateDir(root);
  const targetRoot=path.join(root,'target'),receiptsRoot=path.join(root,'receipts');
  await fs.mkdir(targetRoot);await fs.mkdir(receiptsRoot);await privateDir(targetRoot);await privateDir(receiptsRoot);
  const exe=path.join(root,'flush-fixture.exe');
  // Unsigned source-only compiler fixture. Never install/use this as the
  // protected production helper, which requires Authenticode + exact pin.
  await run('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    ['/nologo','/target:exe','/out:'+exe,path.resolve('native/windows-transfer-volume-flush.cs')],opts);
  const flush=async(dir:string)=>{
    assert([targetRoot,receiptsRoot].includes(dir));verifyWindowsPrivateAcl(dir);
    const r=await run(exe,[dir],opts);assert.equal(r.stdout.trim(),'NEXOWIRE_NTFS_VOLUME_FLUSH_OK');assert.equal(r.stderr.trim(),'');
  };
  await assert.rejects(run(exe,['\\\\.\\C:'],opts));
  await assert.rejects(run(exe,[path.join(root,'missing')],opts));
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const receipts=()=>new ProtectedTransferReceiptStore(receiptsRoot,publicKey,flush);
  const used=new Set<string>();
  const data=Buffer.from('protected Windows test artifact');
  const id=randomUUID(),target=path.join(targetRoot,'final.bin');
  const b:LargeTransferBinding={id,ownerId:'fixture-owner',projectId:'fixture-project',sourceDeviceId:'fixture-source',targetDeviceId:'fixture-target',sourcePath:'source.bin',targetPath:target,stagePath:target+'.nexowire-upload-'+id+'.part',size:data.length,sha256:createHash('sha256').update(data).digest('hex')};
  const lease={epoch:1,token:'fixture-only-not-production-authority'};
  const intent=(kind:'write'|'publish'):LargeTransferIntent=>({kind,requestId:randomUUID(),epoch:1,offset:kind==='publish'?data.length:0,length:kind==='publish'?0:data.length,sha256:b.sha256,dispatched:true});
  const admission:NativeTransferAdmission={
    async admit(binding,l,p,effect){assert.deepEqual(binding,b);assert.deepEqual(l,lease);assert(!used.has(p.requestId));used.add(p.requestId);await effect();},
    async resolveProtectedPaths(binding){verifyWindowsPrivateAcl(targetRoot);assert.equal(binding.targetPath,target);return {stage:binding.stagePath,target:binding.targetPath};},
    flushDirectory:flush,async signFinal(bytes){return sign(null,bytes,privateKey).toString('base64url');},
    persistFinalReceipt:(binding,p,r)=>receipts().persist(binding,p,r),
  };
  const publisher=new NativeTransferPublisher(b.targetDeviceId,admission);
  const w=intent('write');await publisher.writeFenced(b,lease,w,data.toString('base64'),true);
  await assert.rejects(publisher.writeFenced(b,lease,w,data.toString('base64'),true));
  await fs.writeFile(target,'existing',{flag:'wx'});const rejected=intent('publish');
  await assert.rejects(publisher.publishFenced(b,lease,rejected));
  assert.equal(await fs.readFile(target,'utf8'),'existing');assert.deepEqual(await fs.readFile(b.stagePath),data);
  // New intent in isolated fixture, not automatic retry of a production UNKNOWN.
  await fs.unlink(target);const pub=intent('publish');const r=await publisher.publishFenced(b,lease,pub);
  assert(verifyNativeTransferReceipt(b,r,publicKey));assert.deepEqual(await receipts().lookup(b,pub),r);
  assert.deepEqual(await fs.readFile(target),data);await assert.rejects(fs.stat(b.stagePath),{code:'ENOENT'});
  await assert.rejects(publisher.publishFenced(b,lease,pub));assert.deepEqual(await fs.readFile(target),data);
});
