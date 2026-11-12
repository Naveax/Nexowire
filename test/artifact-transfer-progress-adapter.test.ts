import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { ArtifactBridgeStore } from '../src/workspace/artifact-bridge.js';
import { ArtifactTransferProgressAdapter } from '../src/agent/artifact-transfer-progress-adapter.js';

const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const scope={accountId:'account-fixture',projectId:'project-fixture',deviceId:'device-fixture'};

test('64 KiB chunks and resume count ONLY physically persisted store receipts',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-progress-adapter-'));
  try {
    const store=new ArtifactBridgeStore(dir);
    const bytes=Buffer.alloc(65536*2+123,0x71);
    const identity={scope,artifactPath:'models/fixture.bin',producerOperationId:'fixture-op',
      size:bytes.length,sha256:hash(bytes)};
    const request={...identity,repository:'Naveax/Nexowire',commitSha:'a'.repeat(40),
      testStatus:'unverified' as const,acceptanceStatus:'pending' as const};
    const begin=await store.begin(request);
    const first=new ArtifactTransferProgressAdapter(identity);
    first.observeBegin(begin);
    assert.equal(first.snapshot().confirmedOffset,0);
    assert.equal(first.snapshot().state,'uploading');
    const part=bytes.subarray(0,65536);
    const accepted=await store.putChunk(scope,begin.sessionId!,0,part.toString('base64'));
    first.observeChunk(begin.sessionId!,0,part,accepted);
    assert.equal(first.snapshot().confirmedBytes,65536);
    assert.equal(first.snapshot().acknowledgedChunks,1);
    assert.equal(first.snapshot().lastAcknowledgedChunkSha256,hash(part));

    // Simulate adapter reconstruction after caller restart; the store's
    // durable checked offset, not a local estimate, is the resume authority.
    const reopened=await store.begin(request);
    assert.equal(reopened.offset,65536);
    const resumed=new ArtifactTransferProgressAdapter(identity);
    resumed.observeBegin(reopened);
    assert.equal(resumed.snapshot().resumeOffset,65536);
    assert.equal(resumed.snapshot().acknowledgedChunks,1);
    const duplicate=await store.putChunk(scope,reopened.sessionId!,0,part.toString('base64'));
    resumed.observeAlreadyWritten(reopened.sessionId!,0,part,duplicate);
    assert.equal(resumed.snapshot().acknowledgedChunks,1);
    let offset=reopened.offset;
    while(offset<bytes.length){
      const chunk=bytes.subarray(offset,Math.min(offset+65536,bytes.length));
      const receipt=await store.putChunk(scope,reopened.sessionId!,offset,chunk.toString('base64'));
      resumed.observeChunk(reopened.sessionId!,offset,chunk,receipt);
      offset=receipt.offset;
    }
    assert.equal(resumed.snapshot().confirmedBytes,bytes.length);
    assert.equal(resumed.snapshot().acknowledgedChunks,3);
    assert.equal(resumed.snapshot().state,'uploading');
    const committed=await store.commit(scope,reopened.sessionId!);
    resumed.observeCommit(reopened.sessionId!,committed);
    const independentlyRead=await store.get(scope,identity.artifactPath);
    assert.equal(independentlyRead?.sha256,identity.sha256);
    assert.equal(resumed.snapshot().storageConfirmed,true);
    assert.equal(resumed.snapshot().remainingBytes,0);
    const already=await store.begin(request);
    const fresh=new ArtifactTransferProgressAdapter(identity);
    fresh.observeBegin(already);
    assert.equal(fresh.snapshot().state,'complete');
    assert.equal(fresh.snapshot().confirmedOffset,bytes.length);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test('lost mutation response remains UNKNOWN, no automatic replay even if bytes might exist',async()=>{
  const identity={scope,artifactPath:'models/uncertain.bin',producerOperationId:'uncertain-op',
    size:65536,sha256:'a'.repeat(64)};
  const adapter=new ArtifactTransferProgressAdapter(identity);
  adapter.observeBegin({state:'OPEN',sessionId:'a'.repeat(64),offset:0});
  adapter.markUnknown();
  assert.equal(adapter.snapshot().mutationState,'UNKNOWN');
  assert.equal(adapter.snapshot().automaticReplayAllowed,false);
  assert.throws(()=>adapter.observeChunk('a'.repeat(64),0,Buffer.alloc(65536),{
    state:'WRITTEN',offset:65536,
  }),/TRANSFER_NOT_ACTIVE/);
  assert.equal(adapter.snapshot().storageConfirmed,false);
});

test('forged chunk offset and forged complete digest fail closed',()=>{
  const id={scope,artifactPath:'models/forged.bin',producerOperationId:'forged',
    size:65537,sha256:'b'.repeat(64)};
  const a=new ArtifactTransferProgressAdapter(id);
  a.observeBegin({state:'OPEN',sessionId:'c'.repeat(64),offset:0});
  assert.throws(()=>a.observeChunk('c'.repeat(64),0,Buffer.alloc(65536),{
    state:'WRITTEN',offset:65535,
  }),/UNTRUSTED_CHUNK_RECEIPT/);
  assert.equal(a.snapshot().mutationState,'UNKNOWN');
  const b=new ArtifactTransferProgressAdapter(id);
  assert.throws(()=>b.observeBegin({state:'ALREADY_PRESENT',offset:id.size,manifest:{
    version:1,scope,artifactPath:id.artifactPath,producerOperationId:id.producerOperationId,
    repository:'Naveax/Nexowire',commitSha:'a'.repeat(40),size:id.size,
    sha256:'d'.repeat(64),createdAt:new Date().toISOString(),
    testStatus:'unverified',acceptanceStatus:'pending',
  }}),/UNTRUSTED_COMPLETE_MANIFEST/);
  assert.equal(b.snapshot().storageConfirmed,false);
});

test('store rejection never counts as storage completion',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-progress-negative-'));
  try{
    const store=new ArtifactBridgeStore(dir);
    const id={scope,artifactPath:'models/negative.bin',producerOperationId:'negative',
      size:65536,sha256:hash(Buffer.alloc(65536,5))};
    const started=await store.begin({...id,repository:'Naveax/Nexowire',
      commitSha:'a'.repeat(40),testStatus:'unverified',acceptanceStatus:'pending'});
    const adapter=new ArtifactTransferProgressAdapter(id);
    adapter.observeBegin(started);
    await assert.rejects(()=>store.putChunk(scope,started.sessionId!,0,Buffer.alloc(65537).toString('base64')));
    assert.equal(adapter.snapshot().confirmedBytes,0);
    adapter.markUnknown();
    assert.equal(adapter.snapshot().automaticReplayAllowed,false);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
