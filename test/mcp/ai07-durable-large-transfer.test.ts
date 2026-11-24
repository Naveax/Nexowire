import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdtemp,open,readFile,writeFile,stat,link,unlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableLargeTransfer,type LargeTransferAuthority,type LargeTransferRemote,type LargeTransferBinding,type LargeTransferLease,type LargeTransferFinalReceipt,type LargeTransferCommit} from '../../src/mcp/durable-large-transfer.js';
const scope={ownerId:'owner',projectId:'project',sourceDeviceId:'source',targetDeviceId:'target'};
const digest=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
async function fixture(t:import('node:test').TestContext,size=221*1024){
  const dir=await mkdtemp(join(tmpdir(),'nx-durable-'));
  const source=join(dir,'source.bin'),target=join(dir,'target.bin'),db=join(dir,'journal.sqlite');
  const bytes=randomBytes(size);await writeFile(source,bytes);
  const key=randomBytes(32),leases=new Map<string,LargeTransferLease>();
  const committed=new Map<string,{receipt:LargeTransferFinalReceipt;commit:LargeTransferCommit}>();
  const workers=new Set<DurableLargeTransfer>();
  const f={writes:0,publishes:0,hashes:0,maxRead:0,loseWrite:0,losePublish:false,loseCommit:false,noEffect:false,prove:false,limit:Number.MAX_SAFE_INTEGER,gate:undefined as undefined|(()=>Promise<void>)};
  const check=(b:Readonly<LargeTransferBinding>,l:Readonly<LargeTransferLease>)=>assert.deepEqual(leases.get(b.id),l);
  const sign=(r:Omit<LargeTransferFinalReceipt,'proof'>)=>createHmac('sha256',key).update(JSON.stringify(r)).digest('hex');
  const authority:LargeTransferAuthority={
    async assertGrant(s){for(const k of Object.keys(scope) as (keyof typeof scope)[])assert.equal(s[k],scope[k]);},
    async acquire(b,previous){const epoch=Math.max(previous,leases.get(b.id)?.epoch??0)+1;const lease={epoch,token:randomBytes(32).toString('hex')};leases.set(b.id,lease);return lease;},
    async assertCurrent(b,l){check(b,l);await f.gate?.();check(b,l);},
    async proveWriteNoEffect(){return f.prove;},
    async verifyFinal(_b,r){const {proof,...body}=r;return sign(body)===proof;},
    async commitPublished(b,l,r){check(b,l);assert(!committed.has(b.id));const commit={jobId:b.id,requestId:r.requestId,epoch:r.epoch,sha256:r.sha256,commitId:randomBytes(32).toString('hex')};committed.set(b.id,{receipt:r,commit});if(f.loseCommit)throw Error('lost commit ACK');return commit;},
    async recoverPublished(b){return committed.get(b.id);},
  };
  const remote:LargeTransferRemote={
    async limits(){return {maxHashBytes:f.limit,maxOffsetBytes:f.limit};},
    async stat(_d,p){try{const s=await stat(p);return {type:s.isFile()?'file':'other',size:s.size};}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}},
    async hash(_d,p,max){f.hashes++;assert((await stat(p)).size<=max);const hash=createHash('sha256');for await(const chunk of createReadStream(p))hash.update(chunk);return hash.digest('hex');},
    async read(_d,p,offset,length){f.maxRead=Math.max(f.maxRead,length);const fd=await open(p,'r');try{const s=await fd.stat(),b=Buffer.alloc(length),r=await fd.read(b,0,length,offset);return {sourceBytes:s.size,offsetBytes:offset,bytesRead:r.bytesRead,contentBase64:b.subarray(0,r.bytesRead).toString('base64')};}finally{await fd.close();}},
    async writeFenced(b,l,p,base64,first){check(b,l);f.writes++;if(f.noEffect)throw Error('no effect');const data=Buffer.from(base64,'base64');assert.equal(digest(data),p.sha256);const fd=await open(b.stagePath,first?'wx':'r+');try{assert.equal((await fd.stat()).size,p.offset);assert.equal((await fd.write(data,0,data.length,p.offset)).bytesWritten,data.length);await fd.sync();}finally{await fd.close();}if(f.writes===f.loseWrite)throw Error('lost write ACK');return {requestId:p.requestId,epoch:p.epoch,offset:p.offset,length:p.length,sha256:p.sha256};},
    async publishFenced(b,l,p){check(b,l);f.publishes++;await link(b.stagePath,b.targetPath);await unlink(b.stagePath);if(f.losePublish)throw Error('lost publication ACK');const body={jobId:b.id,requestId:p.requestId,epoch:p.epoch,targetDeviceId:b.targetDeviceId,targetPath:b.targetPath,size:b.size,sha256:b.sha256};return {...body,proof:sign(body)};},
  };
  const start=()=>{const w=new DurableLargeTransfer(db,remote,authority);workers.add(w);return w;};
  const close=(w:DurableLargeTransfer)=>{w.close();workers.delete(w);};
  t.after(async()=>{for(const w of workers)w.close();await rm(dir,{recursive:true,force:true});});
  const finish=async(w:DurableLargeTransfer,id:string)=>{for(let i=0;i<100;i++){const v=await w.inspect(id,scope);if(v.state==='COMPLETE')return v;await w.step(id,scope);}throw Error('did not complete');};
  return {source,target,bytes,f,authority,remote,start,close,finish,db};
}
const code=(c:string)=>({code:c});
test('lost second write ACK: reopen, verify exact prefix, never replay',async t=>{const x=await fixture(t);let w=x.start();const j=await w.create(scope,x.source,x.target);await w.step(j.id,scope);x.f.loseWrite=2;await assert.rejects(w.step(j.id,scope),code('TRANSFER_MUTATION_UNKNOWN'));assert.equal((await w.inspect(j.id,scope)).bytesConfirmed,65536);x.close(w);w=x.start();assert.equal((await w.recover(j.id,scope)).bytesConfirmed,131072);assert.equal((await x.finish(w,j.id)).state,'COMPLETE');assert.equal(x.f.writes,4);assert.equal(x.f.publishes,1);assert.deepEqual(await readFile(x.target),x.bytes);});
test('1 MiB transfer is bounded and complete only after publication',async t=>{const x=await fixture(t,1024*1024);const w=x.start();const j=await w.create(scope,x.source,x.target);assert.equal((await x.finish(w,j.id)).sha256,digest(x.bytes));assert.equal(x.f.maxRead,65536);assert.equal(x.f.writes,16);assert.equal(x.f.publishes,1);assert.deepEqual(await readFile(x.target),x.bytes);});
test('empty file still creates a stage and verifies independent digest',async t=>{const x=await fixture(t,0);const w=x.start();const j=await w.create(scope,x.source,x.target);assert.equal((await w.step(j.id,scope)).state,'VERIFIED');assert.equal((await w.step(j.id,scope)).state,'COMPLETE');assert.equal(x.f.writes,1);assert.equal((await stat(x.target)).size,0);});
test('lost native publish ACK is unresolved, destination preserved, no second publish',async t=>{const x=await fixture(t,16);let w=x.start();const j=await w.create(scope,x.source,x.target);await w.step(j.id,scope);x.f.losePublish=true;await assert.rejects(w.step(j.id,scope),code('TRANSFER_MUTATION_UNKNOWN'));x.close(w);w=x.start();await assert.rejects(w.recover(j.id,scope),code('TRANSFER_PUBLICATION_UNRESOLVED'));await assert.rejects(w.step(j.id,scope),code('TRANSFER_RECONCILIATION_REQUIRED'));assert.equal(x.f.publishes,1);assert.deepEqual(await readFile(x.target),x.bytes);});
test('lost external commit ACK: read-only recovery matches original receipt',async t=>{const x=await fixture(t,16);let w=x.start();const j=await w.create(scope,x.source,x.target);await w.step(j.id,scope);x.f.loseCommit=true;await assert.rejects(w.step(j.id,scope),code('TRANSFER_MUTATION_UNKNOWN'));x.close(w);w=x.start();assert.equal((await w.recover(j.id,scope)).state,'COMPLETE');assert.equal(x.f.publishes,1);assert.deepEqual(await readFile(x.target),x.bytes);});
test('tampered destination rejects recovery despite valid committed receipt',async t=>{const x=await fixture(t,16);const w=x.start();const j=await w.create(scope,x.source,x.target);await w.step(j.id,scope);x.f.loseCommit=true;await assert.rejects(w.step(j.id,scope),code('TRANSFER_MUTATION_UNKNOWN'));await writeFile(x.target,Buffer.alloc(16));await assert.rejects(w.recover(j.id,scope),code('TRANSFER_FILE_UNVERIFIED'));assert.equal(x.f.publishes,1);});
test('cancel wins pre-dispatch revision race across SQLite connections',async t=>{const x=await fixture(t,16);const w=x.start(),other=x.start();const j=await w.create(scope,x.source,x.target);let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),gate=new Promise<void>(r=>{release=r;});let calls=0;x.f.gate=async()=>{if(++calls===2){enter();await gate;}};const pending=w.step(j.id,scope);await entered;assert.equal((await other.cancel(j.id,scope)).state,'UNKNOWN');release();await assert.rejects(pending,code('TRANSFER_MUTATION_UNKNOWN'));assert.equal(x.f.writes,0);await assert.rejects(other.recover(j.id,scope),code('TRANSFER_CANCELLED_UNRESOLVED'));});
test('missing stage never proves no effect; explicit authority proof permits new intent',async t=>{const x=await fixture(t,16);const w=x.start();const j=await w.create(scope,x.source,x.target);x.f.noEffect=true;await assert.rejects(w.step(j.id,scope),code('TRANSFER_MUTATION_UNKNOWN'));await assert.rejects(w.recover(j.id,scope),code('TRANSFER_STAGE_UNRESOLVED'));x.f.prove=true;x.f.noEffect=false;assert.equal((await w.recover(j.id,scope)).state,'READY');assert.equal((await x.finish(w,j.id)).state,'COMPLETE');assert.equal(x.f.writes,2);});
test('missing authority and old native limit fail closed before mutation/hash',async t=>{const x=await fixture(t,1);assert.throws(()=>new DurableLargeTransfer(x.db,x.remote,{} as LargeTransferAuthority),code('TRUSTED_TRANSFER_PROVIDER_REQUIRED'));const fd=await open(x.source,'r+');try{await fd.truncate(268435457);}finally{await fd.close();}x.f.limit=268435456;const w=x.start();await assert.rejects(w.create(scope,x.source,x.target),code('NATIVE_LARGE_FILE_UNSUPPORTED'));assert.equal(x.f.hashes,0);assert.equal(x.f.writes,0);});
