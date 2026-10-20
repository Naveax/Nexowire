import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  advanceProposedOwnerWssBoundedTransfer,
  OWNER_WSS_CHUNK_BYTES,OWNER_WSS_BUFFERED_LIMIT,
  type OwnerWssTransferScope,type OwnerWssTransferGrant,
  type OwnerWssStreamDependencies,type OwnerWssChunkFrame,
  type OwnerWssChunkAck,
} from '../src/product/owner-public-wss-stream-flow-proposal.js';

const scope:OwnerWssTransferScope={
  ownerId:'owner-account-01',deviceId:'device-client-01',
  projectId:'project-xyz-01',sessionId:'stream-session-001',
};
const digest='a'.repeat(64);
function harness(totalBytes:number,start=0,inputScope=scope){
  const grant:OwnerWssTransferGrant={
    ...inputScope,status:'active',revision:4,
    sourceIdentity:'source-identity-unique-001',totalBytes,
    sourceSha256:digest,
  };
  let offset=start,reads=0,sends=0;
  let peakBytes=0,queued=0,peakQueued=0;
  let lostAckAt=-1,buffered=0;
  let alteration=false,changes=0,revoked=false;
  const sentOffsets:number[]=[];
  const frameHashes:string[]=[];
  const dependencies:OwnerWssStreamDependencies={
    async readGrant(){
      return {...grant,status:revoked?'revoked':'active'};
    },
    async readReceipt(){
      return {...inputScope,revision:grant.revision,
        sourceSha256:digest,committedOffset:offset};
    },
    async sourceSnapshot(){
      changes++;
      return {sourceSha256:alteration?'b'.repeat(64):digest,
        sourceIdentity:grant.sourceIdentity,totalBytes};
    },
    async readSource(at,length){
      reads++;
      peakBytes=Math.max(peakBytes,length);
      const out=Buffer.alloc(length);
      out.fill((at/OWNER_WSS_CHUNK_BYTES)&255);
      return out;
    },
    bufferedAmount(){return buffered},
    async sendChunk(frame:OwnerWssChunkFrame):Promise<OwnerWssChunkAck>{
      sends++;
      queued+=frame.bytes.length;
      peakQueued=Math.max(peakQueued,queued);
      assert.equal(frame.bytes.byteLength<=OWNER_WSS_CHUNK_BYTES,true);
      assert.equal(frame.bytes.byteLength>0,true);
      assert.equal(frame.chunkSha256,createHash('sha256')
        .update(frame.bytes).digest('hex'));
      assert.deepEqual({
        ownerId:frame.ownerId,deviceId:frame.deviceId,
        projectId:frame.projectId,sessionId:frame.sessionId,
      },inputScope);
      assert.equal(frame.revision,grant.revision);
      assert.equal(frame.offset,offset);
      assert.equal(frame.totalBytes,totalBytes);
      assert.equal(frame.sourceSha256,digest);
      sentOffsets.push(frame.offset);
      frameHashes.push(frame.chunkSha256);
      offset+=frame.bytes.byteLength; // owner durable CAS in fixture
      queued-=frame.bytes.length;
      if(sends===lostAckAt)throw new Error('transport ACK lost after commit');
      return {...inputScope,revision:grant.revision,
        sourceSha256:digest,committedOffset:offset};
    },
  };
  return {
    dependencies,grant,get offset(){return offset},
    set offset(v:number){offset=v},
    get sends(){return sends},get reads(){return reads},
    get peakBytes(){return peakBytes},get peakQueued(){return peakQueued},
    get sentOffsets(){return sentOffsets},
    get changes(){return changes},
    get frameHashes(){return frameHashes},
    set buffered(v:number){buffered=v},
    loseAckAt(v:number){lostAckAt=v},
    replaceSource(){alteration=true},revoke(){revoked=true},
  };
}
test('221 KiB uses bounded 64 KiB chunks and a verified final digest per chunk',async()=>{
  const h=harness(221*1024);
  const done=await advanceProposedOwnerWssBoundedTransfer(scope,h.dependencies);
  assert.equal(done.state,'COMPLETE');
  assert.equal(done.committedOffset,221*1024);
  assert.equal(done.sentChunks,4);
  assert.equal(h.peakBytes,OWNER_WSS_CHUNK_BYTES);
  assert.equal(h.peakQueued,OWNER_WSS_CHUNK_BYTES);
  assert.equal(done.autoReplayAllowed,false);
});
test('1 MiB synthetic payload: 16 sequential frames, never one huge WSS frame',async()=>{
  const h=harness(1024*1024);
  const done=await advanceProposedOwnerWssBoundedTransfer(scope,h.dependencies);
  assert.equal(done.state,'COMPLETE');
  assert.equal(h.sends,16);
  assert.equal(h.peakQueued,OWNER_WSS_CHUNK_BYTES);
  assert.equal(h.sentOffsets[15],15*OWNER_WSS_CHUNK_BYTES);
});
test('256 MiB + 1 and 1 GiB virtual-file tails require no whole-file allocation',async()=>{
  for(const total of [268_435_457,1_073_741_824]){
    const start=total-OWNER_WSS_CHUNK_BYTES-1;
    const h=harness(total,start);
    const r=await advanceProposedOwnerWssBoundedTransfer(scope,h.dependencies);
    assert.equal(r.state,'COMPLETE');
    assert.equal(r.committedOffset,total);
    assert.equal(h.sends,2);
    assert.ok(h.peakBytes<=OWNER_WSS_CHUNK_BYTES);
    assert.ok(h.peakQueued<=OWNER_WSS_CHUNK_BYTES);
  }
});
test('per-call budget 32 caps transfer at 2 MiB and yields durable PARTIAL',async()=>{
  const h=harness(5*1024*1024);
  const r=await advanceProposedOwnerWssBoundedTransfer(scope,h.dependencies);
  assert.equal(r.state,'PARTIAL');
  assert.equal(r.sentChunks,32);
  assert.equal(h.offset,32*OWNER_WSS_CHUNK_BYTES);
  assert.equal(r.autoReplayAllowed,false);
  await assert.rejects(advanceProposedOwnerWssBoundedTransfer(
    scope,h.dependencies,33,
  ),/chunk budget/);
});
test('backpressure yields before reading or sending; retry uses confirmed offset',async()=>{
  const h=harness(221*1024);
  h.buffered=OWNER_WSS_BUFFERED_LIMIT-OWNER_WSS_CHUNK_BYTES+1;
  const busy=await advanceProposedOwnerWssBoundedTransfer(scope,h.dependencies);
  assert.equal(busy.state,'BACKPRESSURE');
  assert.equal(h.sends,0);
  assert.equal(h.reads,0);
  h.buffered=0;
  const done=await advanceProposedOwnerWssBoundedTransfer(scope,h.dependencies);
  assert.equal(done.state,'COMPLETE');
});
test('lost ACK after owner CAS is UNKNOWN; fresh connection resumes only via trusted receipt',async()=>{
  const h=harness(3*OWNER_WSS_CHUNK_BYTES);
  h.loseAckAt(1);
  const unknown=await advanceProposedOwnerWssBoundedTransfer(scope,h.dependencies);
  assert.equal(unknown.state,'UNKNOWN');
  assert.equal(unknown.committedOffset,0);
  assert.equal(unknown.autoReplayAllowed,false);
  assert.equal(h.offset,OWNER_WSS_CHUNK_BYTES);
  h.loseAckAt(-1);
  const resumed=await advanceProposedOwnerWssBoundedTransfer(scope,h.dependencies);
  assert.equal(resumed.state,'COMPLETE');
  assert.deepEqual(h.sentOffsets,[0,OWNER_WSS_CHUNK_BYTES,
    2*OWNER_WSS_CHUNK_BYTES]);
});
test('wrong owner/device/project/session cannot use another scope receipt',async()=>{
  for(const changed of [
    {ownerId:'other-owner-01'}, {deviceId:'other-device-01'},
    {projectId:'other-project-01'}, {sessionId:'other-session-01'},
  ]){
    const h=harness(OWNER_WSS_CHUNK_BYTES);
    await assert.rejects(advanceProposedOwnerWssBoundedTransfer(
      {...scope,...changed},h.dependencies,
    ),/outside scope/);
    assert.equal(h.sends,0);
  }
});
test('two projects with same basename remain independent owner-scoped transfers',async()=>{
  const a=harness(1024,0,scope);
  const bScope={...scope,projectId:'second-project-01',sessionId:'second-session-01'};
  const b=harness(1024,0,bScope);
  await advanceProposedOwnerWssBoundedTransfer(scope,a.dependencies);
  assert.equal(a.offset,1024);
  assert.equal(b.offset,0);
  await advanceProposedOwnerWssBoundedTransfer(bScope,b.dependencies);
  assert.equal(b.offset,1024);
});
test('grant revoke and source change fail closed without any new frame',async()=>{
  const denied=harness(1024);
  denied.revoke();
  await assert.rejects(advanceProposedOwnerWssBoundedTransfer(
    scope,denied.dependencies,
  ),/grant/);
  assert.equal(denied.sends,0);
  const changed=harness(1024);
  changed.replaceSource();
  await assert.rejects(advanceProposedOwnerWssBoundedTransfer(
    scope,changed.dependencies,
  ),/source changed/);
  assert.equal(changed.sends,0);
});
test('corrupt owner receipt and unsafe offsets deny before send',async()=>{
  const h=harness(1024);
  const receipt=h.dependencies.readReceipt;
  h.dependencies.readReceipt=async()=>({...await receipt(),
    committedOffset:Number.MAX_SAFE_INTEGER+1});
  await assert.rejects(advanceProposedOwnerWssBoundedTransfer(
    scope,h.dependencies,
  ),/receipt invalid/);
  assert.equal(h.sends,0);
});
test('source truncated in one 64 KiB frame is rejected before network send',async()=>{
  const h=harness(1024);
  h.dependencies.readSource=async()=>(new Uint8Array(7));
  await assert.rejects(advanceProposedOwnerWssBoundedTransfer(
    scope,h.dependencies,
  ),/truncated/);
  assert.equal(h.sends,0);
});
test('forged ACK offset creates UNKNOWN with no internal replay',async()=>{
  const h=harness(1024);
  const real=h.dependencies.sendChunk;
  h.dependencies.sendChunk=async(frame)=>({
    ...await real(frame),committedOffset:11,
  });
  const result=await advanceProposedOwnerWssBoundedTransfer(scope,h.dependencies);
  assert.equal(result.state,'UNKNOWN');
  assert.equal(h.sends,1);
  assert.equal(result.autoReplayAllowed,false);
});
test('revocation after WSS ACK but before owner receipt blocks success',async()=>{
  const h=harness(1024);
  const real=h.dependencies.sendChunk;
  h.dependencies.sendChunk=async frame=>{
    const ack=await real(frame);
    h.revoke();
    return ack;
  };
  await assert.rejects(advanceProposedOwnerWssBoundedTransfer(
    scope,h.dependencies,
  ),/revoked/);
  assert.equal(h.sends,1);
});
test('simulated racing durable commit denies stale expected offset',async()=>{
  const h=harness(2*OWNER_WSS_CHUNK_BYTES);
  h.offset=OWNER_WSS_CHUNK_BYTES;
  const res=await advanceProposedOwnerWssBoundedTransfer(scope,h.dependencies);
  assert.equal(res.state,'COMPLETE');
  assert.deepEqual(h.sentOffsets,[OWNER_WSS_CHUNK_BYTES]);
});

test('second producer commits while read awaits: deny stale frame before send',async()=>{
  const h=harness(2*OWNER_WSS_CHUNK_BYTES);
  const original=h.dependencies.readSource;
  h.dependencies.readSource=async(at,length)=>{
    const data=await original(at,length);
    h.offset+=length; // another producer wins the durable CAS
    return data;
  };
  await assert.rejects(advanceProposedOwnerWssBoundedTransfer(
    scope,h.dependencies,
  ),/offset changed during source read/);
  assert.equal(h.sends,0);
});
test('full 1 GiB virtual stream remains 64 KiB/frame and 2 MiB/call bounded',async()=>{
  const full=1_073_741_824;
  const h=harness(full);
  const started=performance.now();
  let calls=0,peakSentPerCall=0;
  while(h.offset<full){
    const result=await advanceProposedOwnerWssBoundedTransfer(
      scope,h.dependencies,
    );
    calls++;
    peakSentPerCall=Math.max(peakSentPerCall,result.sentChunks);
    assert.ok(calls<=512);
    assert.equal(result.autoReplayAllowed,false);
  }
  const elapsedMs=performance.now()-started;
  assert.equal(h.offset,full);
  assert.equal(calls,512);
  assert.equal(h.sends,16_384);
  assert.equal(peakSentPerCall,32);
  assert.equal(h.peakBytes,OWNER_WSS_CHUNK_BYTES);
  assert.equal(h.peakQueued,OWNER_WSS_CHUNK_BYTES);
  // Diagnostic-only synthetic throughput; does NOT predict physical WSS.
  assert.ok(elapsedMs>0);
});
test('offset above 4 GiB remains a safe integer with bounded tail frame',async()=>{
  const total=5*1024*1024*1024+1;
  const h=harness(total,total-1);
  const result=await advanceProposedOwnerWssBoundedTransfer(
    scope,h.dependencies,
  );
  assert.equal(result.state,'COMPLETE');
  assert.equal(h.peakBytes,1);
});