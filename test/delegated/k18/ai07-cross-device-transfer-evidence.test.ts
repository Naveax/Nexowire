import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ArtifactBridgeStore, ArtifactBridgeError}
  from '../../../src/workspace/artifact-bridge.js';
import {ingestDeviceArtifact, type ArtifactSourceOps}
  from '../../../src/mcp/artifact-bridge-device-ingest.js';
import {summarizeOfflineTransferProgress}
  from '../../../src/ops/scale-transport-metrics.js';

// AI-07 source-only test. The device IDs are synthetic; this suite NEVER
// invokes a live Agent, Hub, Broker or a production workspace/journal.
const digest=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const scope=(deviceId:string)=>({
  accountId:'ai07-test-account',projectId:'Nexowire',deviceId,
});
const transfer=(deviceId:string,artifactPath:string)=>({
  scope:scope(deviceId),sourcePath:'C:\\ai07-fixture\\transfer.bin',
  artifactPath,repository:'Naveax/Nexowire',
  commitSha:'7'.repeat(40),producerOperationId:'ai07-source-only-receipt',
  testStatus:'unverified' as const,acceptanceStatus:'pending' as const,
  maxChunks:1,
});
const sender=(bytes:Buffer,onRead?:()=>void):ArtifactSourceOps=>({
  stat:async()=>({type:'file',size:bytes.length}),
  sha256:async()=>digest(bytes),
  read:async(_file,offset,limit)=>{
    onRead?.();
    const part=bytes.subarray(offset,offset+limit);
    return {sourceBytes:bytes.length,offsetBytes:offset,
      bytesRead:part.length,contentBase64:part.toString('base64')};
  },
});
async function isolated(run:(root:string)=>Promise<void>){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-ai07-transfer-'));
  try{await run(root)}
  finally{await fs.rm(root,{recursive:true,force:true})}
}

test('AI-07 221 KiB reconnect/restart keeps scope and receiver digest separate',()=>isolated(async root=>{
  const size=221*1024;
  const a=Buffer.alloc(size),b=Buffer.alloc(size);
  for(let i=0;i<size;i++){
    a[i]=(i*7+19)%251;
    b[i]=(i*13+41)%251;
  }
  const artifactPath='ai07/same-name-221-kib.bin';
  const aScope=scope('device-a'),bScope=scope('device-b');
  const aInput=transfer('device-a',artifactPath);
  const first=await ingestDeviceArtifact(new ArtifactBridgeStore(root),sender(a),aInput);
  assert.equal(first.state,'PARTIAL');
  assert.equal(first.offset,65536);
  assert.equal(first.transferredBytes,65536);
  assert.equal(await new ArtifactBridgeStore(root).get(aScope,artifactPath),null);
  assert.equal(await new ArtifactBridgeStore(root).get(bScope,artifactPath),null);

  // New Store instances emulate process/reconnect recovery against durable
  // test-only metadata, not an actual two-PC network or reboot acceptance.
  const offsets=[first.offset];
  let outcome=first;
  for(let attempt=0;attempt<4 && outcome.state!=='COMPLETE';attempt++){
    outcome=await ingestDeviceArtifact(new ArtifactBridgeStore(root),sender(a),aInput);
    offsets.push(outcome.offset);
  }
  assert.deepEqual(offsets,[65536,131072,196608,size]);
  assert.equal(outcome.state,'COMPLETE');
  assert.equal(outcome.sha256,digest(a));
  assert.equal(await new ArtifactBridgeStore(root).get(bScope,artifactPath),null);

  const store=new ArtifactBridgeStore(root);
  const receiver=createHash('sha256');
  for(let offset=0;offset<size;offset+=65536){
    const chunk=await store.readChunk(aScope,artifactPath,offset,65536);
    assert.equal(chunk.offset,offset);
    assert.equal(chunk.totalSize,size);
    receiver.update(Buffer.from(chunk.contentBase64,'base64'));
  }
  assert.equal(receiver.digest('hex'),digest(a));

  // The same logical path under a different device scope cannot inherit A's
  // manifest or its idempotency result.
  const bInput={...transfer('device-b',artifactPath),maxChunks:16};
  const bResult=await ingestDeviceArtifact(store,sender(b),bInput);
  assert.equal(bResult.state,'COMPLETE');
  assert.equal(bResult.transferredBytes,size);
  assert.equal(bResult.sha256,digest(b));
  assert.notEqual(bResult.sha256,outcome.sha256);
  assert.equal((await store.get(aScope,artifactPath))?.sha256,digest(a));
  assert.equal((await store.get(bScope,artifactPath))?.sha256,digest(b));

  let replayReads=0;
  const replay=await ingestDeviceArtifact(store,sender(a,()=>{replayReads++}),aInput);
  assert.equal(replay.state,'ALREADY_PRESENT');
  assert.equal(replay.transferredBytes,0);
  assert.equal(replayReads,0);
}));

test('AI-07 256 MiB + 1 and 1 GiB + 1 are explicitly unsupported by current ingest',()=>isolated(async root=>{
  for(const [label,size] of [
    ['256-mib-plus-one',268_435_457],
    ['one-gib-plus-one',1_073_741_825],
  ] as const){
    let hashes=0,reads=0;
    const oversize:ArtifactSourceOps={
      stat:async()=>({type:'file',size}),
      sha256:async()=>{hashes++;throw Error('HASH_MUST_NOT_BE_CALLED')},
      read:async()=>{reads++;throw Error('READ_MUST_NOT_BE_CALLED')},
    };
    const input=transfer('device-size-test','ai07/'+label+'.bin');
    await assert.rejects(
      ingestDeviceArtifact(new ArtifactBridgeStore(root),oversize,input),
      (error:unknown)=>error instanceof ArtifactBridgeError
        && error.code==='INGEST_SOURCE_INVALID',
    );
    assert.equal(hashes,0);
    assert.equal(reads,0);
    assert.equal(await new ArtifactBridgeStore(root).get(input.scope,input.artifactPath),null);
  }
}));

test('AI-07 1 GiB+ synthetic counters never imply authenticated delivery',()=>{
  // These are arithmetic/label tests only, NOT an allocation or transfer.
  const totalBytes=1_073_741_825;
  const base={
    phase:'PARTIAL',totalBytes,sentBytes:1_100_000_000,
    receivedBytes:totalBytes,acknowledgedBytes:totalBytes,
    finalReceiptVerified:false,
  };
  const withoutReceipt=summarizeOfflineTransferProgress(base);
  assert.equal(withoutReceipt.classification,'SYNTHETIC_EVIDENCE_ONLY');
  assert.equal(withoutReceipt.complete,false);
  assert.equal(withoutReceipt.progressPercent,99);

  const misleading=summarizeOfflineTransferProgress({
    ...base,phase:'COMPLETE',finalReceiptVerified:false,
  });
  assert.equal(misleading.complete,false);
  assert.equal(misleading.progressPercent,99);

  const inconsistent=summarizeOfflineTransferProgress({
    ...base,acknowledgedBytes:totalBytes+1,
  });
  assert.equal(inconsistent.classification,'UNKNOWN');
  assert.equal(inconsistent.complete,false);

  const labelledSynthetic=summarizeOfflineTransferProgress({
    ...base,phase:'COMPLETE',finalReceiptVerified:true,
  });
  assert.equal(labelledSynthetic.complete,true);
  assert.equal(labelledSynthetic.progressPercent,100);
  assert.equal(labelledSynthetic.classification,'SYNTHETIC_EVIDENCE_ONLY');
});
