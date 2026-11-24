import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {NativeTransferPublisher,verifyNativeTransferReceipt,type NativeTransferAdmission} from '../../src/agent/native-transfer-publisher.js';
import {hashNativeTransferFile,readNativeTransferRange} from '../../src/agent/native-transfer-io.js';
import {DurableLargeTransfer,type LargeTransferAuthority,type LargeTransferRemote,type LargeTransferBinding,type LargeTransferLease,type LargeTransferIntent,type LargeTransferFinalReceipt,type LargeTransferCommit} from '../../src/mcp/durable-large-transfer.js';
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const scope={ownerId:'owner',projectId:'project',sourceDeviceId:'source',targetDeviceId:'target'};
const lease={epoch:1,token:'synthetic-test-token-not-a-production-authority'};
async function fixture(t:import('node:test').TestContext){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-native-publisher-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const source=path.join(root,'source'),target=path.join(root,'target');
  const claims=new Set<string>();let mode:'normal'|'deny'|'skip'='normal';let failFlush=false;
  const admission:NativeTransferAdmission={
    async admit(b,l,p,effect){assert.equal(b.targetDeviceId,scope.targetDeviceId);assert.equal(l.epoch,p.epoch);if(mode==='deny'||claims.has(p.requestId))throw Error('denied');claims.add(p.requestId);if(mode!=='skip')await effect();},
    async resolveProtectedPaths(b){assert.equal(path.dirname(b.stagePath),root);assert.equal(b.targetPath,target);return {stage:b.stagePath,target:b.targetPath};},
    async flushDirectory(dir){if(failFlush)throw Error('flush unavailable');const fd=await fs.open(dir,'r');try{await fd.sync();}finally{await fd.close();}},
    async signFinal(bytes){return sign(null,bytes,privateKey).toString('base64url');},
    async persistFinalReceipt(_b,p,receipt){const fd=await fs.open(path.join(root,p.requestId+'.receipt'),'wx',0o600);try{await fd.writeFile(JSON.stringify(receipt));await fd.sync();}finally{await fd.close();}await admission.flushDirectory(root);},
  };
  const publisher=new NativeTransferPublisher(scope.targetDeviceId,admission);
  const binding=(data:Buffer):LargeTransferBinding=>{const id=randomUUID();return {...scope,id,sourcePath:source,targetPath:target,stagePath:target+'.nexowire-upload-'+id+'.part',size:data.length,sha256:sha(data)};};
  const intent=(b:LargeTransferBinding,kind:'write'|'publish',data=Buffer.alloc(0),offset=0):LargeTransferIntent=>({kind,requestId:randomUUID(),epoch:lease.epoch,offset:kind==='publish'?b.size:offset,length:kind==='publish'?0:data.length,sha256:kind==='publish'?b.sha256:sha(data),dispatched:true});
  return {root,source,target,publisher,publicKey,binding,intent,readReceipt:async(id:string)=>JSON.parse(await fs.readFile(path.join(root,id+'.receipt'),'utf8')) as LargeTransferFinalReceipt,mode:(v:typeof mode)=>{mode=v;},failFlush:()=>{failFlush=true;}};
}
test('Native publisher denies replay, malformed content and wrong offset before modifying staged bytes',async t=>{
  const f=await fixture(t),data=Buffer.from('abcd'),b=f.binding(data),p=f.intent(b,'write',data.subarray(0,2));
  await f.publisher.writeFenced(b,lease,p,'YWI=',true);
  await assert.rejects(f.publisher.writeFenced(b,lease,p,'YWI=',true),/denied/);
  const bad=f.intent(b,'write',Buffer.from('cd'),3);
  await assert.rejects(f.publisher.writeFenced(b,lease,bad,'Y2Q=',false),/INVALID|MISMATCH/);
  await assert.rejects(f.publisher.writeFenced(b,lease,f.intent(b,'write',Buffer.from('cd'),2),'eHg=',false),/CHUNK_INVALID/);
  assert.equal(await fs.readFile(b.stagePath,'utf8'),'ab');
});
test('Native publisher uses an actual independent Ed25519 signature and never overwrites an existing target',async t=>{
  const f=await fixture(t),data=Buffer.from('payload'),b=f.binding(data);
  await f.publisher.writeFenced(b,lease,f.intent(b,'write',data),data.toString('base64'),true);
  await fs.writeFile(f.target,'existing',{flag:'wx'});
  await assert.rejects(f.publisher.publishFenced(b,lease,f.intent(b,'publish')),{code:'EEXIST'});
  assert.equal(await fs.readFile(f.target,'utf8'),'existing');assert.deepEqual(await fs.readFile(b.stagePath),data);
  // An explicit fresh test fixture intent, not an automatic retry of UNKNOWN.
  await fs.unlink(f.target);
  const r=await f.publisher.publishFenced(b,lease,f.intent(b,'publish'));
  assert.ok(verifyNativeTransferReceipt(b,r,f.publicKey));
  assert.deepEqual(await f.readReceipt(r.requestId),r);
  assert.equal(verifyNativeTransferReceipt({...b,ownerId:'other'},r,f.publicKey),false);
  assert.equal(verifyNativeTransferReceipt(b,{...r,requestId:randomUUID()},f.publicKey),false);
  assert.deepEqual(await fs.readFile(f.target),data);await assert.rejects(fs.stat(b.stagePath),{code:'ENOENT'});
});
test('unavailable protected authority or missing callback produces no stage',async t=>{
  const f=await fixture(t),data=Buffer.from('data'),b=f.binding(data);
  f.mode('deny');await assert.rejects(f.publisher.writeFenced(b,lease,f.intent(b,'write',data),data.toString('base64'),true),/denied/);
  f.mode('skip');await assert.rejects(f.publisher.writeFenced(b,lease,f.intent(b,'write',data),data.toString('base64'),true),/EFFECT_UNCONFIRMED/);
  await assert.rejects(fs.stat(b.stagePath),{code:'ENOENT'});
});
test('namespace durability failure after link does not issue a receipt or delete the destination',async t=>{
  const f=await fixture(t),data=Buffer.from('data'),b=f.binding(data);
  await f.publisher.writeFenced(b,lease,f.intent(b,'write',data),data.toString('base64'),true);f.failFlush();
  await assert.rejects(f.publisher.publishFenced(b,lease,f.intent(b,'publish')),/flush unavailable/);
  assert.deepEqual(await fs.readFile(f.target),data);
});
test('native publisher verifies and signs an actual 1 GiB + 1 byte stage',{timeout:120000},async t=>{
  const f=await fixture(t),b=f.binding(Buffer.alloc(0));b.size=1024**3+1;
  const fd=await fs.open(b.stagePath,'wx');try{await fd.truncate(b.size);await fd.write(Buffer.from([23]),0,1,b.size-1);await fd.sync();}finally{await fd.close();}
  const h=createHash('sha256'),zero=Buffer.alloc(1024*1024);for(let i=0;i<1024;i++)h.update(zero);h.update(Buffer.from([23]));b.sha256=h.digest('hex');
  const r=await f.publisher.publishFenced(b,lease,f.intent(b,'publish'));
  assert.ok(verifyNativeTransferReceipt(b,r,f.publicKey));assert.equal((await fs.stat(f.target)).size,b.size);
  assert.equal((await readNativeTransferRange(f.target,b.size-1,1)).content[0],23);
});
const labBytes=Number(process.env.NEXOWIRE_AI07_LAB_BYTES??1024*1024);
if(![1024*1024,268435457,1073741825].includes(labBytes))throw Error('Invalid isolated large-transfer lab size');
for(const loseNativeAck of [false,true])test('real native publisher and SQLite worker transfer '+(loseNativeAck?1024*1024:labBytes)+' bytes, recover lost '+(loseNativeAck?'Native publish':'external commit')+' ACK and never republish',{timeout:240000},async t=>{
  const size=loseNativeAck?1024*1024:labBytes;
  const f=await fixture(t);
  const fd=await fs.open(f.source,'wx');try{await fd.truncate(size);await fd.write(Buffer.from([91]),0,1,size-1);await fd.sync();}finally{await fd.close();}
  const expected=createHash('sha256'),zero=Buffer.alloc(1024*1024);
  for(let left=size-1;left>0;left-=Math.min(left,zero.length))expected.update(zero.subarray(0,Math.min(left,zero.length)));
  expected.update(Buffer.from([91]));const expectedSha=expected.digest('hex');
  const chunks=Math.ceil(size/65536);
  let nativeWrites=0,nativePublishes=0,committed:{receipt:LargeTransferFinalReceipt;commit:LargeTransferCommit}|undefined;
  const authority:LargeTransferAuthority={
    async assertGrant(s){assert.equal(s.ownerId,scope.ownerId);},async acquire(){return lease;},async assertCurrent(){},async proveWriteNoEffect(){return false;},
    async verifyFinal(b,r){return verifyNativeTransferReceipt(b,r,f.publicKey);},
    async commitPublished(b,l,r){const commit={jobId:b.id,requestId:r.requestId,epoch:l.epoch,sha256:b.sha256,commitId:randomUUID()};committed={receipt:r,commit};throw Error('lost external commit ACK');},
    async recoverPublished(){return committed;},
    async recoverNativeReceipt(_b,p){return f.readReceipt(p.requestId);},
    async commitRecoveredPublication(b,p,r){assert.equal(p.requestId,r.requestId);assert(!committed);const commit={jobId:b.id,requestId:p.requestId,epoch:p.epoch,sha256:b.sha256,commitId:randomUUID()};committed={receipt:r,commit};return commit;},
  };
  const remote:LargeTransferRemote={
    async limits(){return {maxHashBytes:4*1024**3,maxOffsetBytes:Number.MAX_SAFE_INTEGER};},
    async stat(_d,p){try{const s=await fs.stat(p);return {type:s.isFile()?'file':'other',size:s.size};}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}},
    async hash(_d,p,max){return (await hashNativeTransferFile(p,max)).sha256;},
    async read(_d,p,offset,max){const r=await readNativeTransferRange(p,offset,max);return {sourceBytes:r.size,offsetBytes:r.offsetBytes,bytesRead:r.bytesRead,contentBase64:r.content.toString('base64')};},
    async writeFenced(b,l,p,content,first){nativeWrites++;return f.publisher.writeFenced(b,l,p,content,first);},
    async publishFenced(b,l,p){nativePublishes++;const r=await f.publisher.publishFenced(b,l,p);if(loseNativeAck)throw Error('lost Native publish ACK');return r;},
  };
  const db=path.join(f.root,'worker.sqlite');let worker=new DurableLargeTransfer(db,remote,authority);
  try{const job=await worker.create(scope,f.source,f.target);assert.equal(job.sha256,expectedSha);for(let i=0;i<chunks;i++)await worker.step(job.id,scope);
    assert.equal((await worker.inspect(job.id,scope)).state,'VERIFIED');await assert.rejects(worker.step(job.id,scope),{code:'TRANSFER_MUTATION_UNKNOWN'});
    worker.close();worker=new DurableLargeTransfer(db,remote,authority);
    assert.equal((await worker.recover(job.id,scope)).state,'COMPLETE');assert.equal(nativeWrites,chunks);assert.equal(nativePublishes,1);assert.equal((await hashNativeTransferFile(f.target,size)).sha256,expectedSha);assert.equal((await fs.stat(f.target)).size,size);
  }finally{worker.close();}
});
