import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { OneCallTransferWatchdog, type TransferJobReceipt,
  type TransferWatchIdentity, type TransferReadback } from '../src/agent/one-call-transfer-watchdog.js';

const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const transferId='550e8400-e29b-41d4-a716-446655440010';
const pinned:TransferWatchIdentity={
  requestId:'550e8400-e29b-41d4-a716-446655440001',
  accountId:'account:fixture',projectId:'project-fixture',
  sourceDeviceId:'source-device',targetDeviceId:'target-device',
  sourcePath:'/source/file.bin',targetPath:'/destination/file.bin',
};
function receipt(
  state:TransferJobReceipt['state'],total:number,confirmed:number,sha256:string,
  other:Partial<TransferJobReceipt>={},
):TransferJobReceipt {
  return {id:transferId,state,bytesTotal:total,bytesConfirmed:confirmed,
    sha256,sourceDeviceId:pinned.sourceDeviceId,targetDeviceId:pinned.targetDeviceId,
    sourcePath:pinned.sourcePath,targetPath:pinned.targetPath,
    updatedAt:new Date().toISOString(),...other};
}
function memoryTarget(initial?:Buffer){
  const files=new Map<string,Buffer>();
  const target=pinned.targetDeviceId+':'+pinned.targetPath;
  if(initial)files.set(target,Buffer.from(initial));
  const calls={stat:0,hash:0,read:0};
  const remote:TransferReadback={
    stat:async (device,file)=>{
      assert.equal(device,pinned.targetDeviceId);
      assert.equal(file,pinned.targetPath);
      calls.stat++;
      const data=files.get(device+':'+file);
      if(!data)throw Error('ENOENT');
      return {type:'file',size:data.length,modifiedAt:'fixture-invariant'};
    },
    hash:async (device,file,maxBytes)=>{
      assert.equal(device,pinned.targetDeviceId);
      assert.equal(file,pinned.targetPath);
      const data=files.get(device+':'+file);
      if(!data||data.length>maxBytes)throw Error('ENOENT');
      calls.hash++;
      return digest(data);
    },
    read:async (device,file,offset,size)=>{
      assert.equal(device,pinned.targetDeviceId);
      assert.equal(file,pinned.targetPath);
      const data=files.get(device+':'+file);
      if(!data)throw Error('ENOENT');
      const piece=data.subarray(offset,offset+size);
      calls.read++;
      return {sourceBytes:data.length,offsetBytes:offset,bytesRead:piece.length,
        contentBase64:piece.toString('base64')};
    },
  };
  return {remote,files,target,calls};
}

test('#596 actual response schema: 64KiB receipt progress is not immutable/worker completion',async()=>{
  let now=Date.now();
  const bytes=Buffer.alloc(2*65536+113,0x41),hash=digest(bytes);
  const obs=new OneCallTransferWatchdog({...pinned,expectedSourceSha256:hash},()=>now);
  const dst=memoryTarget();
  obs.observeStart(receipt('QUEUED',bytes.length,0,hash));
  assert.equal(obs.snapshot().receiptChunkCount,0);
  obs.observeStatus(receipt('RUNNING',bytes.length,65536,hash));
  assert.equal(obs.snapshot().receiptChunkCount,1);
  assert.equal(obs.snapshot().bytesConfirmedReceipt,65536);
  obs.observeWorkerSignal({state:'running',reportedCompleted:100});
  assert.equal(obs.snapshot().workerCompletedVerified,false);
  assert.equal(obs.snapshot().readbackVerified,false);
  obs.observeStatus(receipt('PUBLISHING',bytes.length,bytes.length,hash));
  assert.equal(await obs.verifyPublishedTarget(dst.remote),false);
  assert.equal(dst.calls.hash,0,'PUBLISHING must not count as published');
  obs.observeStatus(receipt('COMPLETED',bytes.length,bytes.length,hash));
  assert.equal(obs.snapshot().publicationReported,true);
  assert.equal(await obs.verifyPublishedTarget(dst.remote),false,'missing published target fails');
  assert.equal(obs.snapshot().workerCompletedVerified,false);
});

test('atomic publication reported COMPLETED requires independent destination SHA/readback',async()=>{
  const bytes=Buffer.alloc(221*1024+17,0x55),hash=digest(bytes);
  let now=Date.now();
  const obs=new OneCallTransferWatchdog(pinned,()=>now);
  const dst=memoryTarget();
  obs.observeStart(receipt('RUNNING',bytes.length,0,hash));
  obs.observeStatus(receipt('PUBLISHING',bytes.length,bytes.length,hash));
  assert.equal(await obs.verifyPublishedTarget(dst.remote),false);
  dst.files.set(dst.target,Buffer.from(bytes));
  obs.observeStatus(receipt('COMPLETED',bytes.length,bytes.length,hash));
  assert.equal(await obs.verifyPublishedTarget(dst.remote),true);
  assert.equal(obs.snapshot().readbackVerified,true);
  assert.equal(obs.snapshot().storageBytesVerified,bytes.length);
  assert.equal(obs.snapshot().readbackSha256,hash);
  assert.equal(obs.snapshot().lastReadbackChunkSha256,digest(bytes.subarray(3*65536)));
  assert.equal(obs.snapshot().atomicNoOverwriteVerified,false,
    'a reply plus readback cannot prove no-overwrite publication history');
  assert.equal(obs.snapshot().workerCompletedVerified,false);
  assert.ok(dst.calls.hash>0&&dst.calls.read>0);
  now+=30001;
  assert.equal(obs.snapshot().readbackVerified,false,'proof expires');
  assert.equal(obs.snapshot().storageBytesVerified,null);
  assert.equal(await obs.verifyPublishedTarget(dst.remote),true,'fresh readback renews proof');
});

test('hash mismatch, wrong device and disk tampering fail-closed',async()=>{
  const expected=Buffer.alloc(65536,0x31), actual=Buffer.alloc(65536,0x32);
  const obs=new OneCallTransferWatchdog({...pinned,expectedSourceSha256:digest(expected)});
  obs.observeStart(receipt('COMPLETED',65536,65536,digest(expected)));
  const dst=memoryTarget(actual);
  assert.equal(await obs.verifyPublishedTarget(dst.remote),false);
  assert.equal(obs.snapshot().readbackVerified,false);
  assert.equal(obs.snapshot().workerCompletedVerified,false);
  const wrongDevice=new OneCallTransferWatchdog(pinned);
  assert.throws(()=>wrongDevice.observeStart(receipt('QUEUED',65536,0,digest(expected),
    {targetDeviceId:'impostor'})),/TRANSFER_RECEIPT_SCOPE_OR_DIGEST_MISMATCH/);
  assert.equal(wrongDevice.snapshot().mutationUnknown,true);
});

test('zero progress, fake worker percentage, lost PID and stalls never verify',()=>{
  let now=Date.now();
  const obs=new OneCallTransferWatchdog(pinned,()=>now);
  const hash='f'.repeat(64);
  obs.observeStart(receipt('QUEUED',65536*2,0,hash));
  obs.observeStatus(receipt('RUNNING',65536*2,0,hash));
  obs.observeWorkerSignal({state:'running',reportedCompleted:999});
  now+=31000;
  assert.equal(obs.warning(),'NO_STORAGE_PROGRESS');
  assert.equal(obs.snapshot().bytesConfirmedReceipt,0);
  assert.equal(obs.snapshot().workerCompletedVerified,false);
  obs.observeWorkerSignal({state:'lost',reportedCompleted:1000});
  assert.equal(obs.warning(),'WORKER_PID_LOST');
  assert.equal(obs.snapshot().readbackVerified,false);
  assert.equal(obs.snapshot().automaticReplayAllowed,false);
});

test('MUTATION_UNKNOWN, RECOVERY_REQUIRED and resumed offset cannot auto-replay',()=>{
  const hash='a'.repeat(64),size=3*65536;
  const obs=new OneCallTransferWatchdog(pinned);
  obs.observeStart(receipt('QUEUED',size,0,hash));
  obs.observeStatus(receipt('RUNNING',size,65536,hash));
  obs.observeStatus(receipt('MUTATION_UNKNOWN',size,65536,hash));
  assert.equal(obs.warning(),'MUTATION_UNKNOWN');
  assert.equal(obs.snapshot().automaticReplayAllowed,false);
  assert.throws(()=>obs.observeStatus(receipt('RUNNING',size,2*65536,hash)),
    /UNKNOWN_MUTATION_REQUIRES_EXPLICIT_RESUME/);
  assert.equal(obs.snapshot().mutationUnknown,true);
  const restarted=new OneCallTransferWatchdog(pinned);
  restarted.observeStart(receipt('QUEUED',size,0,hash));
  restarted.observeStatus(receipt('RECOVERY_REQUIRED',size,65536,hash));
  assert.equal(restarted.warning(),'MUTATION_UNKNOWN');
  restarted.observeExplicitResume(receipt('QUEUED',size,65536,hash),true);
  assert.equal(restarted.snapshot().resumeOffset,65536);
  assert.equal(restarted.snapshot().readbackVerified,false);
  assert.equal(restarted.snapshot().automaticReplayAllowed,false);
});

test('cancel request, final canceled and false publication cannot be completed',()=>{
  const hash='b'.repeat(64),size=65536;
  const obs=new OneCallTransferWatchdog(pinned);
  obs.observeStart(receipt('RUNNING',size,0,hash));
  obs.observeCancel(receipt('CANCEL_REQUESTED',size,0,hash));
  obs.observeStatus(receipt('CANCELLED',size,0,hash));
  assert.equal(obs.snapshot().workerCompletedVerified,false);
  assert.throws(()=>obs.observeStatus(receipt('COMPLETED',size,size,hash)),
    /TRANSFER_TERMINAL_ROLLBACK|TRANSFER_PUBLISHED_AFTER_CANCEL/);
  assert.equal(obs.snapshot().mutationUnknown,true);
});

test('stale status, changed id/hash, bogus updatedAt and non-monotonic offsets reject',()=>{
  const h='c'.repeat(64);
  const changedId=new OneCallTransferWatchdog(pinned);
  changedId.observeStart(receipt('QUEUED',65536,0,h));
  assert.throws(()=>changedId.observeStatus(receipt('RUNNING',65536,0,h,{
    id:'550e8400-e29b-41d4-a716-446655440099',
  })),/TRANSFER_ID_CHANGED/);
  const regressing=new OneCallTransferWatchdog(pinned);
  regressing.observeStart(receipt('RUNNING',131072,65536,h));
  assert.throws(()=>regressing.observeStatus(receipt('RUNNING',131072,0,h)),
    /TRANSFER_OFFSET_ROLLBACK/);
  const forged=new OneCallTransferWatchdog(pinned);
  assert.throws(()=>forged.observeStart(receipt('COMPLETED',65536,0,h)),
    /COMPLETED_WITH_UNPUBLISHED_BYTES/);
  const future=new OneCallTransferWatchdog(pinned);
  assert.throws(()=>future.observeStart(receipt('QUEUED',65536,0,h,{
    updatedAt:new Date(Date.now()+3600000).toISOString(),
  })),/TRANSFER_RECEIPT_TIMESTAMP_INVALID/);
});

test('1GiB safe integer counters never allocate huge payload or claim readback',async()=>{
  const size=1024*1024*1024+17,h='e'.repeat(64);
  const obs=new OneCallTransferWatchdog(pinned);
  obs.observeStart(receipt('QUEUED',size,0,h));
  obs.observeStatus(receipt('RUNNING',size,3*65536,h));
  assert.equal(obs.snapshot().receiptChunkCount,3);
  assert.equal(obs.snapshot().expectedChunks,16385);
  obs.observeStatus(receipt('COMPLETED',size,size,h));
  assert.equal(await obs.verifyPublishedTarget(memoryTarget().remote),false,
    'Native 1.0.5 hash ceiling remains a hard block');
  assert.equal(obs.snapshot().workerCompletedVerified,false);
});

test('target mutation between first and final hash aborts trusted readback',async()=>{
  const payload=Buffer.alloc(65536+7,0x20),original=digest(payload);
  const obs=new OneCallTransferWatchdog(pinned);
  obs.observeStart(receipt('COMPLETED',payload.length,payload.length,original));
  const backing=memoryTarget(payload);
  const remote:TransferReadback={
    ...backing.remote,
    read:async(device,file,offset,size)=>{
      const result=await backing.remote.read(device,file,offset,size);
      backing.files.set(backing.target,Buffer.alloc(payload.length,0x21));
      return result;
    },
  };
  assert.equal(await obs.verifyPublishedTarget(remote),false);
  assert.equal(obs.snapshot().readbackVerified,false);
  assert.equal(obs.snapshot().workerCompletedVerified,false);
});

test('state rollback from PUBLISHING, missing digest and failed offset refuse false publication',()=>{
  const h='1'.repeat(64),size=65536;
  const obs=new OneCallTransferWatchdog(pinned);
  obs.observeStart(receipt('RUNNING',size,65536,h));
  obs.observeStatus(receipt('PUBLISHING',size,size,h));
  assert.throws(()=>obs.observeStatus(receipt('RUNNING',size,size,h)),
    /PUBLISHING_STATE_ROLLBACK/);
  assert.equal(obs.snapshot().mutationUnknown,true);
  assert.equal(obs.snapshot().workerCompletedVerified,false);
  const forged=new OneCallTransferWatchdog(pinned);
  assert.throws(()=>forged.observeStart(receipt('QUEUED',size,0,'not-sha256')),
    /TRANSFER_RECEIPT_SCOPE_OR_DIGEST_MISMATCH/);
  const rejected=new OneCallTransferWatchdog(pinned);
  assert.throws(()=>rejected.observeStart(receipt('PUBLISHING',size,size-1,h)),
    /TRANSFER_RECEIPT_SCOPE_OR_DIGEST_MISMATCH/);
});

test('FAILED requires explicit owner resume; a status poll cannot resurrect it',()=>{
  const h='2'.repeat(64),size=65536;
  const obs=new OneCallTransferWatchdog(pinned);
  obs.observeStart(receipt('FAILED',size,0,h));
  assert.throws(()=>obs.observeStatus(receipt('RUNNING',size,0,h)),
    /TRANSFER_TERMINAL_ROLLBACK/);
  const recovered=new OneCallTransferWatchdog(pinned);
  recovered.observeStart(receipt('FAILED',size,0,h));
  recovered.observeExplicitResume(receipt('QUEUED',size,0,h),true);
  assert.equal(recovered.snapshot().phase,'QUEUED');
  assert.equal(recovered.snapshot().workerCompletedVerified,false);
  assert.equal(recovered.snapshot().automaticReplayAllowed,false);
});
