import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, createHmac, randomBytes} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CrossDeviceTransferJobs, type TransferJob, type TransferRemote}
  from '../src/mcp/cross-device-transfer-jobs.js';
import {TransferTrustError, type TrustedFinalReceiptVerifier}
  from '../src/workspace/artifact-job-trust.js';

const content=Buffer.alloc(65_536+29);
for(let i=0;i<content.length;i++)content[i]=(i*7+19)&255;
const sha=(x:Buffer)=>createHash('sha256').update(x).digest('hex');
const input={accountId:'account:qa08-final',projectId:'Nexowire',
  sourceDeviceId:'synthetic-source',sourcePath:'/synthetic/from.bin',
  targetDeviceId:'synthetic-target',targetPath:'/synthetic/to.bin'};
type Mode='valid'|'ack-only'|'foreign-request-id'|'forged-proof'|'corrupt-final'|'lost-publish-ack';
async function fixture(run:(dir:string)=>Promise<void>){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-08-final-receipt-'));
  try{await run(dir);}finally{await fs.rm(dir,{force:true,recursive:true});}
}
function rig(mode:Mode) {
  const secret=randomBytes(32);
  let stage=Buffer.alloc(0), target:Buffer|undefined, nativePublish=0, nativeWrites=0;
  const sign=(claims:Record<string,unknown>)=>
    createHmac('sha256',secret).update(JSON.stringify(claims)).digest('hex');
  const verifier:TrustedFinalReceiptVerifier={
    verify:async (_job,receipt)=>{
      const {proof,...claims}=receipt;
      return proof===sign(claims);
    },
  };
  const remote:TransferRemote={
    stat:async (device,file)=>{
      const x=device===input.sourceDeviceId?content:
        file===input.targetPath?target:stage;
      if(!x)throw Object.assign(Error('ENOENT'),{code:'ENOENT'});
      return {type:'file',size:x.length};
    },
    hash:async (device,file)=>{
      const x=device===input.sourceDeviceId?content:
        file===input.targetPath?target:stage;
      if(!x)throw Object.assign(Error('ENOENT'),{code:'ENOENT'});
      return sha(x);
    },
    read:async (device,_file,offset,length)=>{
      const all=device===input.sourceDeviceId?content:stage;
      const chunk=all.subarray(offset,offset+length);
      return {sourceBytes:all.length,offsetBytes:offset,
        bytesRead:chunk.length,contentBase64:chunk.toString('base64')};
    },
    write:async()=>{throw Error('LEGACY_NATIVE_WRITE_FORBIDDEN')},
    moveNoOverwrite:async()=>{throw Error('LEGACY_PUBLISH_FORBIDDEN')},
    writeFenced:async (_job,e,body)=>{
      const b=Buffer.from(body,'base64');
      assert.equal(e.offset,stage.length);
      assert.equal(e.length,b.length);
      assert.equal(e.sha256,sha(b));
      stage=Buffer.concat([stage,b]);
      nativeWrites++;
      return {requestId:e.requestId,epoch:e.epoch,offset:e.offset,
        length:e.length,sha256:e.sha256};
    },
    publishFenced:async(job,epoch,_token,requestId)=>{
      nativePublish++;
      assert.equal(requestId!==undefined,true,'durable publication id must reach Native');
      assert.equal(target,undefined,'publish cannot replay');
      target=Buffer.from(stage);
      const claims={requestId: mode==='foreign-request-id'?
        '00000000-0000-4000-8000-000000000000':requestId!,
        jobId:job.id,accountId:job.accountId,projectId:job.projectId,
        targetDeviceId:job.targetDeviceId,targetPath:job.targetPath,
        bytesTotal:job.bytesTotal,sha256:job.sha256,epoch};
      if(mode==='lost-publish-ack')throw Error('PUBLISHED_BUT_ACK_LOST');
      if(mode==='ack-only')return;
      if(mode==='corrupt-final')target[0]=target[0]!^0xff;
      return {...claims,proof:mode==='forged-proof'?'0'.repeat(64):sign(claims)};
    },
  };
  const authority={
    acquire:async()=>({epoch:1,token:'SYNTHETIC-ONLY-EXTERNAL-LEASE-XXXXXXXXXXXX'}),
    assertCurrent:async()=>undefined,
  };
  const grants={assertCurrent:async()=>undefined};
  return {remote,verifier,authority,grants,
    get writes(){return nativeWrites;},get publishes(){return nativePublish;},
    get target(){return target;}};
}
async function state(dir:string,id:string):Promise<TransferJob>{
  return JSON.parse(await fs.readFile(path.join(dir,id+'.json'),'utf8')) as TransferJob;
}
const start=async (dir:string,mode:Mode,withVerifier=true)=>{
  const f=rig(mode);
  const jobs=new CrossDeviceTransferJobs(dir,f.remote,{
    requireExternalAuthority:true,authority:f.authority,grants:f.grants,
    requireAuthenticatedFinalReceipt:true,
    ...(withVerifier?{finalReceiptVerifier:f.verifier}:{}),
  });
  return {f,jobs};
};
test('hosted cannot start Native transfer with no independently injected receipt verifier',
  async()=>fixture(async root=>{
    const {f,jobs}=await start(root,'valid',false);
    await assert.rejects(jobs.start(input),(e:unknown)=>
      e instanceof TransferTrustError&&e.code==='FINAL_RECEIPT_VERIFIER_REQUIRED');
    assert.equal(f.writes,0);
    assert.equal(f.publishes,0);
  }));
for(const [mode,code] of [
  ['ack-only','FINAL_RECEIPT_MISMATCH'],
  ['foreign-request-id','FINAL_RECEIPT_MISMATCH'],
  ['forged-proof','FINAL_RECEIPT_UNAUTHENTICATED'],
  ['corrupt-final','FINAL_DESTINATION_UNVERIFIED'],
  ['lost-publish-ack','TRANSFER_PUBLISH_OUTCOME_UNKNOWN'],
] as const){
  test('hosted '+mode+' publication cannot become COMPLETED, no second publish',
    async()=>fixture(async root=>{
      const {f,jobs}=await start(root,mode);
      const initial=await jobs.start(input);
      await jobs.waitForIdle(initial.id);
      const j=await state(root,initial.id);
      assert.equal(j.state,'MUTATION_UNKNOWN');
      assert.equal(j.errorCode,code);
      assert.equal(j.bytesConfirmed,content.length);
      assert.equal(j.publication?.dispatched,true);
      assert.ok(j.publication?.requestId);
      assert.equal(f.publishes,1);
      const otherHub=new CrossDeviceTransferJobs(root,f.remote,{
        requireExternalAuthority:true,authority:f.authority,grants:f.grants,
        requireAuthenticatedFinalReceipt:true,finalReceiptVerifier:f.verifier,
      });
      assert.equal((await otherHub.cancel(initial.id,input.accountId,
        input.sourceDeviceId,input.targetDeviceId)).state,'MUTATION_UNKNOWN');
      assert.equal((await state(root,initial.id)).errorCode,code);
      assert.equal(f.publishes,1);
    }));
}
test('hosted signed native publication proof + exact destination bytes can complete only once',
  async()=>fixture(async root=>{
    const {f,jobs}=await start(root,'valid');
    const initial=await jobs.start(input);
    await jobs.waitForIdle(initial.id);
    const j=await state(root,initial.id);
    assert.equal(j.state,'COMPLETED');
    assert.equal(j.bytesConfirmed,content.length);
    assert.equal(j.sha256,sha(content));
    assert.equal(j.publication?.dispatched,true);
    assert.equal(f.publishes,1);
    assert.equal(f.writes,2);
    assert.deepEqual(f.target,content);
    await assert.rejects(jobs.cancel(initial.id,input.accountId,
      input.sourceDeviceId,input.targetDeviceId),
      (e:unknown)=>e instanceof Error && 'code' in e && e.code==='TRANSFER_FINALIZED');
    assert.equal(f.publishes,1);
  }));
