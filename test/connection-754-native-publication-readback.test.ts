import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type {
  AuthenticatedTransferRoute, TransferBinding, TransferCheckpoint,
} from '../src/mcp/cross-device-transfer-continuity.js';
import {
  inspectOneCallWorkerConnectionJournal,
  type AuthenticatedFinalPublicationReceipt,
  type FencedWorkerJournalSnapshot,
  type TrustedNativePublicationReceiptReadback,
  type TrustedPublishedTargetReadback,
} from '../src/mcp/cross-device-worker-journal-link.js';

const bytes=Buffer.alloc(65536,0x31);
const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v)) as T;
function fixture(){
  const ownerId='fixture-owner', projectId='fixture-project';
  const sourceDeviceId='fixture-source', destinationDeviceId='fixture-target';
  const binding:TransferBinding={
    jobId:randomUUID(),ownerId,projectId,sourceDeviceId,destinationDeviceId,
    sourcePath:'/fixture/source',targetPath:'/fixture/target',
    stagePath:'/fixture/target.pending',sourceSha256:digest(bytes),
    totalBytes:bytes.length,
  };
  const epoch=19,requestId=randomUUID();
  const worker:FencedWorkerJournalSnapshot={
    id:binding.jobId,accountId:ownerId,projectId,
    sourceDeviceId,targetDeviceId:destinationDeviceId,
    sourcePath:binding.sourcePath,targetPath:binding.targetPath,stagePath:binding.stagePath,
    bytesTotal:binding.totalBytes,bytesConfirmed:binding.totalBytes,
    sha256:binding.sourceSha256,state:'COMPLETED',
    fencing:{epoch,token:'independent-worker-lease-token-000001'},
    publication:{requestId,epoch,sha256:digest(bytes),dispatched:true},
  };
  const checkpoint:TransferCheckpoint={
    binding,revision:17,epoch:5,offset:binding.totalBytes,
    status:'ready',
  };
  const route:AuthenticatedTransferRoute={
    ownerId,projectId,sourceDeviceId,destinationDeviceId,epoch:5,
  };
  const key=randomBytes(32);
  const claims={
    requestId,jobId:binding.jobId,accountId:ownerId,projectId,
    targetDeviceId:destinationDeviceId,targetPath:binding.targetPath,
    bytesTotal:bytes.length,sha256:digest(bytes),epoch,
  };
  const sign=(v:Record<string,unknown>)=>createHmac('sha256',key)
    .update(JSON.stringify(v)).digest('hex');
  const originalReceipt:AuthenticatedFinalPublicationReceipt={
    ...claims,proof:sign(claims),
  };
  let signedReceipt=clone(originalReceipt);
  let physicalTarget=Buffer.from(bytes);
  let socketEpoch=5,ownerCurrent=true,leaseCurrent=true;
  let receiptReads=0,targetReads=0,ownerChecks=0;
  const receiptReadback:TrustedNativePublicationReceiptReadback={
    inspect:async()=>{
      receiptReads++;
      const {proof,...provided}=signedReceipt;
      const expected=Buffer.from(sign(provided),'hex');
      const actual=Buffer.from(proof,'hex');
      if(actual.length!==expected.length||!timingSafeEqual(actual,expected))
        return {kind:'invalid'} as const;
      return {kind:'verified',receipt:clone(signedReceipt)} as const;
    },
  };
  const targetReadback:TrustedPublishedTargetReadback={
    inspect:async w=>{
      targetReads++;
      return {kind:'verified' as const,deviceId:w.targetDeviceId,
        targetPath:w.targetPath,bytesTotal:physicalTarget.length,
        sha256:digest(physicalTarget)};
    },
  };
  const query=(extra:Partial<Parameters<typeof inspectOneCallWorkerConnectionJournal>[0]>={})=>
    inspectOneCallWorkerConnectionJournal({
      worker,checkpoint,route,
      authorize:async()=>ownerCurrent,
      workerLease:{check:async()=>leaseCurrent},
      ownerAdmission:{ownerEpoch:9,grantGeneration:4,
        deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),privilege:'CORE'},
      ownerEpochWitness:{assertFresh:async c=>{
        ownerChecks++;
        return ownerCurrent&&c.ownerEpoch===9&&c.grantGeneration===4&&
          /^[0-9a-f]{64}$/.test(c.challengeNonce);
      }},
      sessionWitness:{currentEpoch:async()=>socketEpoch},
      publicationReceiptReadback:receiptReadback,
      publishedTargetReadback:targetReadback,
      ...extra,
    });
  return {worker,checkpoint,route,query,originalReceipt,
    /** Fixture-only protected Native signer for adversarial authentic but
     * FOREIGN receipts; never available from worker or MCP inputs. */
    resign:(receipt:AuthenticatedFinalPublicationReceipt)=>{
      const {proof:_old,...claims}=receipt;
      return {...claims,proof:sign(claims)};
    },
    get counters(){return {receiptReads,targetReads,ownerChecks}},
    setReceipt:(v:AuthenticatedFinalPublicationReceipt)=>{signedReceipt=clone(v)},
    setTarget:(v:Buffer)=>{physicalTarget=Buffer.from(v)},
    setSocket:(e:number)=>{socketEpoch=e},
    revoke:()=>{ownerCurrent=false},
    revokeLease:()=>{leaseCurrent=false},
  };
}

test('#754 exact signed final receipt plus independent target full SHA is observational, never a CAS commit',async()=>{
  const f=fixture();
  const frozen=JSON.stringify({w:f.worker,c:f.checkpoint});
  const result=await f.query();
  assert.equal(result.state,'publication_verified_not_committed');
  assert.equal(result.checkpointAdvanced,false);
  assert.equal(result.automaticallyReplayable,false);
  assert.equal(result.mutationExecuted,false);
  assert.equal(result.externalSideEffectProven,false);
  assert.equal(result.verifiedPrefixBytes,f.worker.bytesTotal);
  assert.equal(f.counters.receiptReads,1);
  assert.equal(f.counters.targetReads,1);
  assert.equal(JSON.stringify({w:f.worker,c:f.checkpoint}),frozen);
});

test('missing, undispatched or legacy void publication cannot complete even at full matching offsets',async()=>{
  for(const kind of ['missing','reserved','no-verifier','no-target'] as const){
    const f=fixture();
    if(kind==='missing')f.worker.publication=undefined;
    if(kind==='reserved')f.worker.publication!.dispatched=false;
    const result=await f.query(kind==='no-verifier'?
      {publicationReceiptReadback:undefined}:kind==='no-target'?
      {publishedTargetReadback:undefined}:{});
    assert.equal(result.state,'unverified_completion',kind);
    assert.equal(f.counters.receiptReads,0);
    assert.equal(f.counters.targetReads,0);
  }
});

test('forged or old Native receipt ID, epoch, SHA, device, job and target path are rejected',async()=>{
  for(const field of ['requestId','epoch','sha256','targetDeviceId','targetPath','jobId','accountId','projectId','bytesTotal'] as const){
    const f=fixture();
    const receipt=clone(f.originalReceipt);
    if(field==='epoch'||field==='bytesTotal')receipt[field]=receipt[field]+1;
    else receipt[field]=field==='sha256'?'0'.repeat(64):field==='requestId'?
      randomUUID():'foreign-'+field;
    // A genuine test-only Native signature for stale/foreign claims still
    // MUST fail exact publication identity after independent verification.
    f.setReceipt(f.resign(receipt));
    const out=await f.query();
    assert.equal(out.state,'unverified_completion',field);
    assert.equal(out.checkpointAdvanced,false);
  }
});

test('independently signed old receipt cannot certify corrupted or foreign published target bytes',async()=>{
  const f=fixture();
  const corrupted=Buffer.from(bytes);corrupted[0]=corrupted[0]!^0xff;
  f.setTarget(corrupted);
  const result=await f.query();
  assert.equal(result.state,'unverified_completion');
  assert.equal(f.counters.receiptReads,1);
  assert.equal(f.counters.targetReads,1);
  assert.equal(result.automaticallyReplayable,false);
  const f2=fixture();
  assert.equal((await f2.query({
    publishedTargetReadback:{inspect:async()=>({
      kind:'verified' as const,deviceId:'foreign-device',
      targetPath:f2.worker.targetPath,bytesTotal:bytes.length,sha256:digest(bytes),
    })},
  })).state,'unverified_completion');
});

test('expired CORE or changed worker lease while target readback is paused cannot accept final ACK',async()=>{
  for(const what of ['owner','lease'] as const){
    const f=fixture();
    let entered!:()=>void,release!:()=>void;
    const held=new Promise<void>(r=>{entered=r});
    const resume=new Promise<void>(r=>{release=r});
    const promise=f.query({
      publishedTargetReadback:{inspect:async w=>{
        entered();await resume;
        return {kind:'verified' as const,deviceId:w.targetDeviceId,
          targetPath:w.targetPath,bytesTotal:bytes.length,sha256:digest(bytes)};
      }},
    });
    await held;
    if(what==='owner')f.revoke();else f.revokeLease();
    release();
    const out=await promise;
    assert.equal(out.state,'authority_blocked');
    assert.equal(out.checkpointAdvanced,false);
    assert.equal(f.checkpoint.offset,bytes.length);
  }
});

test('double reconnect while final receipt readback is paused fences socket epoch, not worker lease epoch',async()=>{
  const f=fixture();
  let entered!:()=>void,release!:()=>void;
  const held=new Promise<void>(r=>{entered=r});
  const resume=new Promise<void>(r=>{release=r});
  const pending=f.query({
    publishedTargetReadback:{inspect:async w=>{
      entered();await resume;
      return {kind:'verified' as const,deviceId:w.targetDeviceId,
        targetPath:w.targetPath,bytesTotal:bytes.length,sha256:digest(bytes)};
    }},
  });
  await held;
  f.setSocket(7);release();
  const first=await pending;
  assert.equal(first.state,'epoch_stale');
  assert.equal(first.automaticallyReplayable,false);
  assert.equal(f.checkpoint.epoch,5);
  f.route.epoch=7;f.checkpoint.epoch=7;
  assert.equal((await f.query()).state,'publication_verified_not_committed');
  f.setSocket(8);
  assert.equal((await f.query()).state,'epoch_stale');
  assert.equal(f.worker.publication?.requestId,f.originalReceipt.requestId);
});

test('orphan UNKNOWN publication with authentic receipt and full target never silently becomes COMPLETED',async()=>{
  const f=fixture();
  for(const state of ['MUTATION_UNKNOWN','RECOVERY_REQUIRED','FAILED'] as const){
    f.worker.state=state;
    const out=await f.query();
    assert.equal(out.state,'mutation_unknown',state);
    assert.equal(out.automaticallyReplayable,false);
    assert.equal(f.counters.receiptReads,0);
    assert.equal(f.counters.targetReads,0);
  }
});

test('malformed publisher envelope, mismatched lease epoch and reserved publication block readback',async()=>{
  for(const mode of ['badId','badEpoch','badDigest','badFlag'] as const){
    const f=fixture();
    const pub=f.worker.publication!;
    if(mode==='badId')pub.requestId='not-uuid';
    if(mode==='badEpoch')pub.epoch++;
    if(mode==='badDigest')pub.sha256='0'.repeat(64);
    if(mode==='badFlag')pub.dispatched='yes' as unknown as boolean;
    const out=await f.query();
    assert.equal(out.state,'journal_mismatch',mode);
    assert.equal(f.counters.receiptReads,0);
  }
});


test('WAL-restored publication intent stays UNKNOWN through double reconnect without replay',async t=>{
  const fs=await import('node:fs/promises');
  const os=await import('node:os');
  const path=await import('node:path');
  const {DatabaseSync}=await import('node:sqlite');
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'nw-06-publication-wal-'));
  t.after(async()=>fs.rm(folder,{recursive:true,force:true}));
  const f=fixture();
  f.worker.state='MUTATION_UNKNOWN';
  f.checkpoint.status='unknown';
  const dbpath=path.join(folder,'receipt.sqlite');
  let db=new DatabaseSync(dbpath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE journal (k TEXT PRIMARY KEY,v TEXT NOT NULL)');
  db.prepare('INSERT INTO journal(k,v) VALUES (?,?)').run('worker',JSON.stringify(f.worker));
  db.prepare('INSERT INTO journal(k,v) VALUES (?,?)').run('checkpoint',JSON.stringify(f.checkpoint));
  db.close();
  db=new DatabaseSync(dbpath);
  const get=(k:string)=>JSON.parse((db.prepare('SELECT v FROM journal WHERE k=?')
    .get(k) as {v:string}).v);
  const restartedWorker=get('worker') as FencedWorkerJournalSnapshot;
  const restartedCP=get('checkpoint') as TransferCheckpoint;
  db.close();
  assert.equal(restartedWorker.publication?.requestId,f.originalReceipt.requestId);
  Object.assign(f.worker,restartedWorker);
  Object.assign(f.checkpoint,restartedCP);
  for(const nextEpoch of [5,6,7]){
    f.setSocket(nextEpoch);
    if(nextEpoch>5){
      assert.equal((await f.query()).state,'epoch_stale');
      // Accepted synthetic external reconnect CAS, NOT performed by this
      // observer; absence of it in production requires a hard denial.
      f.route.epoch=nextEpoch;
      f.checkpoint.epoch=nextEpoch;
    }
    const result=await f.query();
    assert.equal(result.state,'mutation_unknown');
    assert.equal(result.automaticallyReplayable,false);
    assert.equal(result.checkpointAdvanced,false);
    assert.equal(result.externalSideEffectProven,false);
    assert.equal(f.worker.publication?.requestId,f.originalReceipt.requestId);
    assert.equal(f.checkpoint.offset,bytes.length);
  }
  assert.equal(f.counters.receiptReads,0);
  assert.equal(f.counters.targetReads,0);
  f.revoke();
  assert.equal((await f.query()).state,'authority_blocked');
});
