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
type Mode='wrong-external-commit'|'revoke-at-final-journal'|'valid'|'ack-only'|'foreign-request-id'|'forged-proof'|'corrupt-final'|'lost-publish-ack';
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
  let active = true;
  let publishChecks = 0;
  const authority={
    acquire:async()=>({epoch:1,token:'SYNTHETIC-ONLY-EXTERNAL-LEASE-XXXXXXXXXXXX'}),
    assertCurrent:async (_job:unknown,_lease:unknown,stage?:string)=>{
      if (!active) throw new TransferTrustError('NATIVE_LEASE_EXPIRED',
        'External authority was revoked before publication was committed.');
      if (mode==='revoke-at-final-journal' && stage==='PUBLISH' &&
          ++publishChecks===4) {
        // Revoked after the final precheck, before external conditional commit.
        active=false;
      }
    },
    commitPublished:async (job:{id:string;sha256:string},
      signed:{requestId:string;epoch:number})=>{
      if(!active)throw new TransferTrustError('NATIVE_LEASE_EXPIRED',
        'Independent external commit rejects revoked owner or lease.');
      return {jobId:job.id,requestId:mode==='wrong-external-commit'?
        '00000000-0000-4000-8000-000000000000':signed.requestId,
        epoch:signed.epoch,sha256:job.sha256,
        durableCommitId:'SYNTHETIC-EXTERNAL-COMMIT-'+signed.requestId};
    },
  };
  const grants={assertCurrent:async()=>{
    if(!active)throw new TransferTrustError('CORE_OWNER_REVOKED','Owner revoked.');
  }};
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
  ['wrong-external-commit','EXTERNAL_PUBLICATION_COMMIT_INVALID'],
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
    assert.match(j.publication.durableCommitId??'', /^SYNTHETIC-EXTERNAL-COMMIT-/);
    assert.equal(f.publishes,1);
    assert.equal(f.writes,2);
    assert.deepEqual(f.target,content);
    await assert.rejects(jobs.cancel(initial.id,input.accountId,
      input.sourceDeviceId,input.targetDeviceId),
      (e:unknown)=>e instanceof Error && 'code' in e && e.code==='TRANSFER_FINALIZED');
    assert.equal(f.publishes,1);
  }));

test('P0: revoke between final lease precheck and local COMPLETED needs atomic external commit',
  async()=>fixture(async root=>{
    const {f,jobs}=await start(root,'revoke-at-final-journal');
    const initial=await jobs.start(input);
    await jobs.waitForIdle(initial.id);
    const j=await state(root,initial.id);
    assert.equal(f.publishes,1);
    assert.equal(j.state,'MUTATION_UNKNOWN',
      'Local journal cannot certify COMPLETED without atomically current external authority');
    assert.equal(j.errorCode,'NATIVE_LEASE_EXPIRED');
    assert.equal(j.bytesConfirmed,content.length);
    assert.ok(j.publication?.dispatched);
    assert.equal(j.publication?.durableCommitId,undefined);
  }));

test('strict hosted start rejects a verifier without an atomic external final commit provider',
 async()=>fixture(async root=>{
   const fx=rig('valid');
   const jobs=new CrossDeviceTransferJobs(root,fx.remote,{
     requireExternalAuthority:true,
     authority:{acquire:fx.authority.acquire,assertCurrent:fx.authority.assertCurrent},
     grants:fx.grants,requireAuthenticatedFinalReceipt:true,
     finalReceiptVerifier:fx.verifier,
   });
   await assert.rejects(jobs.start(input),(e:unknown)=>
     e instanceof TransferTrustError&&e.code==='EXTERNAL_PUBLICATION_COMMIT_REQUIRED');
   assert.equal(fx.writes,0);
   assert.equal(fx.publishes,0);
 }));

test('P0: lost final Native ACK publication UNKNOWN cannot be requeued by explicit new-Hub resume',
  async()=>fixture(async root=>{
    const f=rig('lost-publish-ack');
    let leaseAcquires=0,stageReads=0;
    const authority={
      ...f.authority,
      acquire:async (_job:unknown,mode:'new'|'resume')=>{
        leaseAcquires++;
        return {epoch:mode==='resume'?2:1,
          token:'SYNTHETIC-ONLY-EXTERNAL-LEASE-XXXXXXXXXXXX'};
      },
    };
    const remote={
      ...f.remote,
      read:async (...args:Parameters<typeof f.remote.read>)=>{
        stageReads++;
        return f.remote.read(...args);
      },
    };
    const create=()=>new CrossDeviceTransferJobs(root,remote,{
      requireExternalAuthority:true,authority,grants:f.grants,
      requireAuthenticatedFinalReceipt:true,finalReceiptVerifier:f.verifier,
    });
    const first=create();
    const started=await first.start(input);
    await first.waitForIdle(started.id);
    const old=await state(root,started.id);
    assert.equal(old.state,'MUTATION_UNKNOWN');
    assert.equal(old.errorCode,'TRANSFER_PUBLISH_OUTCOME_UNKNOWN');
    assert.equal(old.publication?.dispatched,true);
    assert.equal(old.publication?.durableCommitId,undefined);
    assert.equal(f.publishes,1);
    const leaseBefore=leaseAcquires,readsBefore=stageReads;
    const second=create();
    await assert.rejects(second.start({...input,resumeTransferId:started.id}),
      (err:unknown)=>err instanceof Error && 'code' in err &&
        err.code==='TRANSFER_PUBLICATION_UNRESOLVED');
    await second.waitForIdle(started.id);
    const after=await state(root,started.id);
    assert.equal(after.state,'MUTATION_UNKNOWN');
    assert.equal(after.errorCode,old.errorCode);
    assert.deepEqual(after.publication,old.publication);
    assert.equal(after.bytesConfirmed,old.bytesConfirmed);
    assert.equal((await second.status(started.id,input.accountId,
      input.sourceDeviceId,input.targetDeviceId)).state,'MUTATION_UNKNOWN');
    assert.equal(leaseAcquires,leaseBefore,'no new epoch used to restart an already dispatched publication');
    assert.equal(stageReads,readsBefore,'no new source or stage readback');
    assert.equal(f.publishes,1,'Native final effect may not be replayed');
  }));
