import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { ArtifactBridgeStore } from '../src/workspace/artifact-bridge.js';
import { OneCallTransferWatchdog } from '../src/agent/one-call-transfer-watchdog.js';

const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const scope={accountId:'account-fixture',projectId:'project-fixture',deviceId:'device-fixture'};
const requestId='550e8400-e29b-41d4-a716-446655440001';
const id=(size:number,sha256:string)=>({
  scope,artifactPath:'transfers/fixture.bin',sha256,size,requestId,
});

test('actual Artifact Bridge store receipts: one-call PARTIAL then COMPLETE is not worker completion',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-one-call-receipts-'));
  try{
    const store=new ArtifactBridgeStore(root);
    const content=Buffer.alloc(65536*2+143,0x31);
    const pinned=id(content.length,sha(content));
    const {requestId:_requestId,...storedIdentity}=pinned;
    const meta={...storedIdentity,repository:'Naveax/Nexowire',commitSha:'a'.repeat(40),
      producerOperationId:'fixture-transfer',testStatus:'unverified' as const,
      acceptanceStatus:'pending' as const};
    const begin=await store.begin(meta);
    const w=new OneCallTransferWatchdog(pinned);
    assert.equal(w.snapshot().receiptBytes,0);
    let offset=0;
    for(let n=0;n<2;n++){
      const piece=content.subarray(offset,offset+65536);
      const stored=await store.putChunk(scope,begin.sessionId!,offset,piece.toString('base64'));
      const advanced=stored.offset-offset;
      offset=stored.offset;
      w.observeIngestReceipt({state:'PARTIAL',size:content.length,sha256:pinned.sha256,
        artifactPath:pinned.artifactPath,offset,transferredBytes:advanced});
    }
    assert.equal(w.snapshot().receiptChunkCount,2);
    assert.equal(w.snapshot().storageVerified,false);
    assert.equal(w.snapshot().confirmedStorageBytes,null);
    assert.equal(w.snapshot().workerCompletedVerified,false);
    const piece=content.subarray(offset);
    const stored=await store.putChunk(scope,begin.sessionId!,offset,piece.toString('base64'));
    await store.commit(scope,begin.sessionId!);
    w.observeIngestReceipt({state:'COMPLETE',size:content.length,sha256:pinned.sha256,
      artifactPath:pinned.artifactPath,offset:stored.offset,transferredBytes:piece.length});
    assert.equal(w.snapshot().stage,'reported_complete');
    assert.equal(w.snapshot().storageVerified,false);
    assert.equal(await w.verifyStorage(store),true);
    assert.equal(w.snapshot().stage,'storage_verified');
    assert.equal(w.snapshot().confirmedStorageBytes,content.length);
    assert.equal(w.snapshot().expectedChunks,3);
    assert.equal(w.snapshot().lastVerifiedChunkSha256,sha(piece));
    assert.equal(w.snapshot().workerCompletedVerified,false);
    assert.equal(w.snapshot().automaticReplayAllowed,false);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('one-call PARTIAL or COMPLETE cannot be trusted when disk lacks committed artifact',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-one-call-fake-'));
  try{
    const w=new OneCallTransferWatchdog(id(65536,'a'.repeat(64)));
    w.observeIngestReceipt({state:'COMPLETE',sha256:'a'.repeat(64),
      size:65536,offset:65536,transferredBytes:65536,artifactPath:'transfers/fixture.bin'});
    assert.equal(w.snapshot().stage,'reported_complete');
    assert.equal(await w.verifyStorage(new ArtifactBridgeStore(root)),false);
    assert.equal(w.snapshot().stage,'mutation_unknown');
    assert.equal(w.snapshot().storageVerified,false);
    assert.equal(w.snapshot().workerCompletedVerified,false);
    assert.equal(w.watchdogWarning(),'MUTATION_UNKNOWN');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('stalled fake worker with zero stored bytes cannot claim 100%',()=>{
  let now=100000;
  const w=new OneCallTransferWatchdog(id(65536,'b'.repeat(64)),()=>now);
  w.observeWorkerSignal({state:'running',reportedCompleted:100});
  now+=31000;
  assert.equal(w.watchdogWarning(),'NO_STORAGE_PROGRESS');
  assert.equal(w.snapshot().reportedWorkerCompletedUnverified,100);
  assert.equal(w.snapshot().receiptBytes,0);
  assert.equal(w.snapshot().workerCompletedVerified,false);
  assert.equal(w.snapshot().storageVerified,false);
  w.observeWorkerSignal({state:'lost',reportedCompleted:100});
  assert.equal(w.watchdogWarning(),'WORKER_PID_LOST');
  assert.equal(w.snapshot().workerState,'lost');
  assert.equal(w.snapshot().automaticReplayAllowed,false);
});

test('partial unknown, explicit resume status and cancel never trigger replay or completion',()=>{
  const w=new OneCallTransferWatchdog(id(65536*2,'c'.repeat(64)));
  w.observeIngestReceipt({state:'PARTIAL',size:131072,offset:65536,
    transferredBytes:65536,sha256:'c'.repeat(64),artifactPath:'transfers/fixture.bin'});
  w.markMutationUnknown();
  assert.equal(w.snapshot().mutationUnknown,true);
  assert.equal(w.snapshot().automaticReplayAllowed,false);
  assert.throws(()=>w.observeIngestReceipt({state:'PARTIAL',size:131072,offset:131072,
    transferredBytes:65536,sha256:'c'.repeat(64),artifactPath:'transfers/fixture.bin'}),
    /TRANSFER_RECONCILIATION_REQUIRED/);
  w.observeStatusReceipt({requestId,state:'partial',offset:65536,
    size:131072,sha256:'c'.repeat(64)});
  assert.equal(w.snapshot().stage,'partial');
  assert.equal(w.snapshot().storageVerified,false);
  w.observeCancelReceipt({requestId,canceled:true,offset:65536});
  assert.equal(w.snapshot().stage,'canceled');
  assert.equal(w.snapshot().workerCompletedVerified,false);
  assert.equal(w.snapshot().automaticReplayAllowed,false);
  assert.throws(()=>w.observeIngestReceipt({state:'COMPLETE',size:131072,offset:131072,
    transferredBytes:65536,sha256:'c'.repeat(64),artifactPath:'transfers/fixture.bin'}),
    /TRANSFER_RECONCILIATION_REQUIRED/);
});

test('forged offset, hash, requestId, cancel and status transition fail closed',()=>{
  const w=new OneCallTransferWatchdog(id(65536,'d'.repeat(64)));
  assert.throws(()=>w.observeStatusReceipt({requestId:'550e8400-e29b-41d4-a716-446655440002',
    state:'complete',offset:65536,size:65536,sha256:'d'.repeat(64)}),
  /TRANSFER_STATUS_SCOPE_OR_OFFSET_MISMATCH/);
  assert.equal(w.snapshot().mutationUnknown,true);
  const altered=new OneCallTransferWatchdog(id(65536,'e'.repeat(64)));
  assert.throws(()=>altered.observeIngestReceipt({
    state:'COMPLETE',size:65536,offset:65535,transferredBytes:65535,
    sha256:'e'.repeat(64),artifactPath:'transfers/fixture.bin'}),
    /INGEST_RECEIPT_MISMATCH/);
  assert.equal(altered.snapshot().storageVerified,false);
  const canceled=new OneCallTransferWatchdog(id(65536,'f'.repeat(64)));
  assert.throws(()=>canceled.observeCancelReceipt({requestId,canceled:false,offset:0}),
    /UNTRUSTED_CANCEL_RECEIPT/);
});

test('large transfer receipt uses bounded integer counters without allocating a 1 GiB file',()=>{
  const size=1024*1024*1024+23;
  const w=new OneCallTransferWatchdog(id(size,'a'.repeat(64)));
  w.observeTrustedResumeOffset(65536*200);
  assert.equal(w.snapshot().receiptChunkCount,200);
  assert.equal(w.snapshot().resumeOffset,65536*200);
  w.observeIngestReceipt({state:'PARTIAL',size,sha256:'a'.repeat(64),
    artifactPath:'transfers/fixture.bin',offset:65536*202,transferredBytes:65536*2});
  assert.equal(w.snapshot().receiptChunkCount,202);
  assert.equal(w.snapshot().storageVerified,false);
  assert.equal(w.snapshot().workerCompletedVerified,false);
});

test('disk tampering invalidates reported COMPLETE despite matching MCP receipt SHA',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-one-call-corrupt-'));
  try{
    const store=new ArtifactBridgeStore(root);
    const data=Buffer.alloc(1024,0x51);
    const pinned=id(data.length,sha(data));
    const {requestId:_requestId,...storedIdentity}=pinned;
    const begin=await store.begin({...storedIdentity,
      producerOperationId:'tamper-op',repository:'Naveax/Nexowire',
      commitSha:'a'.repeat(40),testStatus:'unverified',acceptanceStatus:'pending'});
    await store.putChunk(scope,begin.sessionId!,0,data.toString('base64'));
    await store.commit(scope,begin.sessionId!);
    // Alter the exact content-addressed object on the isolated test disk.
    // This is explicitly NOT a production/user artifact.
    async function corruptObject(dir:string):Promise<boolean>{
      for(const entry of await fs.readdir(dir,{withFileTypes:true})){
        const file=path.join(dir,entry.name);
        if(entry.isDirectory()){if(await corruptObject(file))return true;}
        else if(entry.isFile()&&entry.name===pinned.sha256){
          await fs.writeFile(file,Buffer.alloc(1024,0x52));return true;
        }
      }
      return false;
    }
    assert.equal(await corruptObject(root),true);
    const w=new OneCallTransferWatchdog(pinned);
    w.observeIngestReceipt({state:'COMPLETE',sha256:pinned.sha256,
      size:pinned.size,offset:pinned.size,transferredBytes:pinned.size,
      artifactPath:pinned.artifactPath});
    assert.equal(await w.verifyStorage(store),false);
    assert.equal(w.snapshot().storageVerified,false);
    assert.equal(w.snapshot().workerCompletedVerified,false);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('storage check expires after 30 seconds and needs fresh disk verification',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-one-call-expiry-'));
  try{
    let now=Date.now();
    const store=new ArtifactBridgeStore(root);
    const content=Buffer.alloc(77,0x41);
    const pinned=id(content.length,sha(content));
    const {requestId:_requestId,...storedIdentity}=pinned;
    const begin=await store.begin({...storedIdentity,producerOperationId:'expiry-op',
      repository:'Naveax/Nexowire',commitSha:'a'.repeat(40),
      testStatus:'unverified',acceptanceStatus:'pending'});
    await store.putChunk(scope,begin.sessionId!,0,content.toString('base64'));
    await store.commit(scope,begin.sessionId!);
    const w=new OneCallTransferWatchdog(pinned,()=>now);
    w.observeIngestReceipt({state:'COMPLETE',sha256:pinned.sha256,
      size:pinned.size,offset:pinned.size,transferredBytes:pinned.size,
      artifactPath:pinned.artifactPath});
    assert.equal(await w.verifyStorage(store),true);
    assert.equal(w.snapshot().storageVerified,true);
    now+=30001;
    assert.equal(w.snapshot().stage,'storage_stale');
    assert.equal(w.snapshot().storageVerified,false);
    assert.equal(w.snapshot().confirmedStorageBytes,null);
    assert.equal(w.snapshot().workerCompletedVerified,false);
    assert.equal(await w.verifyStorage(store),true);
    assert.equal(w.snapshot().storageVerified,true);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
