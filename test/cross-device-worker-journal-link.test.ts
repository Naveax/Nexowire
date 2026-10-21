import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  type AuthenticatedTransferRoute,
  type TransferBinding,
  type TransferCheckpoint,
} from '../src/mcp/cross-device-transfer-continuity.js';
import {
  ownerGrantEpochGuard,
  type CurrentAuthenticatedTransferGrant,
  type TransferGrantFence,
} from '../src/mcp/cross-device-transfer-owner-grant.js';
import {
  inspectOneCallWorkerConnectionJournal,
  type FencedWorkerJournalSnapshot, type WorkerLeaseWitness,
} from '../src/mcp/cross-device-worker-journal-link.js';

const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const binary = Buffer.alloc(65536, 0x61);
const chunkSha = hash(binary);
const bound = (): TransferBinding => ({
  jobId: randomUUID(), ownerId:'fixture-owner',
  projectId:'fixture-project', sourceDeviceId:'work-pc-fixture',
  destinationDeviceId:'naveax-fixture',
  sourcePath:'/synthetic/source.bin', targetPath:'/synthetic/target.bin',
  stagePath:'/synthetic/target.bin.part', sourceSha256:chunkSha,
  totalBytes:binary.length,
});
const route = (epoch=5): AuthenticatedTransferRoute => ({
  ownerId:'fixture-owner', projectId:'fixture-project',
  sourceDeviceId:'work-pc-fixture', destinationDeviceId:'naveax-fixture',
  epoch,
});
function rows() {
  const b=bound();
  const requestId=randomUUID();
  const checkpoint: TransferCheckpoint = {
    binding:b,revision:8,epoch:5,offset:0,status:'unknown',
    pending:{requestId,epoch:4,offset:0,length:binary.length,
      sha256:chunkSha,ackObserved:false},
  };
  const worker: FencedWorkerJournalSnapshot = {
    id:b.jobId,accountId:b.ownerId,projectId:b.projectId,
    sourceDeviceId:b.sourceDeviceId,targetDeviceId:b.destinationDeviceId,
    sourcePath:b.sourcePath,targetPath:b.targetPath,stagePath:b.stagePath,
    bytesTotal:b.totalBytes,bytesConfirmed:0,sha256:b.sourceSha256,
    state:'MUTATION_UNKNOWN',
    fencing:{epoch:27,token:'test-only-external-lease-'+randomUUID()},
    pending:{requestId,epoch:27,offset:0,length:binary.length,sha256:chunkSha},
  };
  return {worker,checkpoint};
}
const lease: WorkerLeaseWitness={check:async()=>true};
const authorized=async()=>true;
const rightReadback={
  inspect:async (w:FencedWorkerJournalSnapshot,p:{offset:number;length:number;sha256:string})=>({
    kind:'verified' as const,deviceId:w.targetDeviceId,
    offset:p.offset,length:p.length,sha256:chunkSha,
  }),
};
const check = (
  worker:FencedWorkerJournalSnapshot,checkpoint:TransferCheckpoint,
  override:Partial<Parameters<typeof inspectOneCallWorkerConnectionJournal>[0]>={},
)=> inspectOneCallWorkerConnectionJournal({
  worker,checkpoint,route:route(),authorize:authorized,
  workerLease:lease,sessionWitness:{currentEpoch:async r=>r.epoch},
  stageReadback:rightReadback,...override,
});

test('lost ACK + independently verified destination chunk remains readback-only, never auto replays',async()=>{
  const {worker,checkpoint}=rows();
  const state=await check(worker,checkpoint);
  assert.equal(state.state,'readback_verified_not_committed');
  assert.equal(state.verifiedPrefixBytes,0);
  assert.equal(state.requestId,worker.pending?.requestId);
  assert.equal(state.automaticallyReplayable,false);
  assert.equal(state.checkpointAdvanced,false);
  assert.equal(state.externalSideEffectProven,false);
});

test('CORE revoke while trusted 64KiB readback is in flight fails closed before evidence acceptance',async()=>{
  const {worker,checkpoint}=rows();
  let revoke=false;
  const owner=async()=>!revoke;
  const outcome=await check(worker,checkpoint,{
    authorize:owner,
    stageReadback:{inspect:async (w,p)=>{
      revoke=true;
      return {kind:'verified' as const,deviceId:w.targetDeviceId,
        offset:p.offset,length:p.length,sha256:p.sha256};
    }},
  });
  assert.equal(outcome.state,'authority_blocked');
  assert.equal(outcome.verifiedPrefixBytes,0);
});

test('independent worker lease changes mid-readback, even with owner CORE still active',async()=>{
  const {worker,checkpoint}=rows();
  let epoch=27;
  const l: WorkerLeaseWitness={check:async w=>w.fencing?.epoch===epoch};
  assert.equal((await check(worker,checkpoint,{workerLease:l,
    stageReadback:{inspect:async (w,p)=>{
      epoch=28;
      return {kind:'verified' as const,deviceId:w.targetDeviceId,
        offset:p.offset,length:p.length,sha256:p.sha256};
    }},
  })).state,'authority_blocked');
});

test('stale/wrong device and per-chunk requestId, offset, SHA and lease epochs fail closed',async()=>{
  const {worker,checkpoint}=rows();
  const changes: FencedWorkerJournalSnapshot[]=[
    {...worker,targetDeviceId:'other-device'},
    {...worker,sourceDeviceId:'other-source'},
    {...worker,projectId:'other-project'},
    {...worker,pending:{...worker.pending!,requestId:randomUUID()}},
    {...worker,pending:{...worker.pending!,sha256:'f'.repeat(64)}},
    {...worker,pending:{...worker.pending!,epoch:26}},
    {...worker,pending:{...worker.pending!,offset:1}},
    {...worker,pending:undefined},
  ];
  for(const changed of changes) {
    const result=await check(changed,checkpoint);
    assert.equal(result.state,'journal_mismatch');
    assert.equal(result.automaticallyReplayable,false);
  }
  const stale=await check(worker,checkpoint,{route:route(4)});
  assert.equal(stale.state,'epoch_stale');
});

test('wrong destination readback and partial/prefix corruption remain UNKNOWN',async()=>{
  const {worker,checkpoint}=rows();
  const forged=await check(worker,checkpoint,{
    stageReadback:{inspect:async(w,p)=>({kind:'verified' as const,
      deviceId:'wrong-agent',offset:p.offset,length:p.length,sha256:p.sha256})},
  });
  assert.equal(forged.state,'mutation_unknown');
  const corrupt=await check(worker,checkpoint,{
    stageReadback:{inspect:async(w,p)=>({kind:'verified' as const,
      deviceId:w.targetDeviceId,offset:p.offset,length:p.length,
      sha256:'0'.repeat(64)})},
  });
  assert.equal(corrupt.state,'mutation_unknown');
  const partial=await check(worker,checkpoint,{
    stageReadback:{inspect:async()=>({kind:'partial' as const})},
  });
  assert.equal(partial.state,'mutation_unknown');
});

test('cancel while unknown pending cannot become verified CANCELLED, despite #634 old worker status',async()=>{
  const {worker,checkpoint}=rows();
  worker.state='CANCELLED';
  const result=await check(worker,checkpoint);
  assert.equal(result.state,'cancel_pending');
  assert.equal(result.verifiedPrefixBytes,0);
  assert.equal(result.automaticallyReplayable,false);
  assert.equal(result.checkpointAdvanced,false);
});

test('worker-offset/checkpoint divergence or fake completed job is NOT a trusted final postcondition',async()=>{
  const {worker,checkpoint}=rows();
  worker.bytesConfirmed=binary.length;
  worker.pending=undefined;
  checkpoint.pending=undefined;
  checkpoint.status='ready';
  assert.equal((await check(worker,checkpoint)).state,'journal_mismatch');
  checkpoint.offset=binary.length;
  worker.state='COMPLETED';
  checkpoint.status='complete';
  assert.equal((await check(worker,checkpoint)).state,'unverified_completion');
  assert.equal((await check(worker,checkpoint)).externalSideEffectProven,false);
});

test('synthetic trusted CORE epoch revoke and ROOT 15-min session generation independent of WSS/worker epochs',async()=>{
  const {worker,checkpoint}=rows();
  const admission:TransferGrantFence={
    ownerId:worker.accountId,projectId:worker.projectId,
    sourceDeviceId:worker.sourceDeviceId,destinationDeviceId:worker.targetDeviceId,
    grantEpoch:71,mode:'root',rootEpoch:13,rootExpiresAt:'2026-10-21T13:12:00Z',
  };
  let grant:CurrentAuthenticatedTransferGrant={
    ...admission,enabled:true,revoked:false,brokerAttested:true,
  };
  const authorize=ownerGrantEpochGuard(admission,{current:async()=>grant},
    ()=>Date.parse('2026-10-21T13:00:00Z'));
  assert.equal((await check(worker,checkpoint,{authorize})).state,
    'readback_verified_not_committed');
  grant={...grant,rootEpoch:14};
  assert.equal((await check(worker,checkpoint,{authorize})).state,'authority_blocked');
  grant={...grant,rootEpoch:13,grantEpoch:72};
  assert.equal((await check(worker,checkpoint,{authorize})).state,'authority_blocked');
  grant={...grant,grantEpoch:71,revoked:true};
  assert.equal((await check(worker,checkpoint,{authorize})).state,'authority_blocked');
});

test('missing lease/grant authority never creates trusted prefix evidence',async()=>{
  const {worker,checkpoint}=rows();
  const cases=[
    {workerLease:undefined},
    {sessionWitness:undefined},
    {authorize:undefined},
    {worker:{...worker,fencing:undefined}},
    {workerLease:{check:async()=>{throw Error('CAS_UNAVAILABLE')}}},
  ];
  for(const override of cases) {
    const result=await check(worker,checkpoint,override);
    assert.equal(result.state,'authority_blocked');
  }
});


test('disposable SQLite WAL/FULL worker+Connection journal reopening never credits a lost ACK',async()=>{
  const fs=await import('node:fs/promises');
  const path=await import('node:path');
  const os=await import('node:os');
  const sqlite=await import('node:sqlite');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-06-wal-worker-'));
  try {
    const {worker,checkpoint}=rows();
    const dbpath=path.join(dir,'two-journals.sqlite');
    let db=new sqlite.DatabaseSync(dbpath);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE worker (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE cp (id TEXT PRIMARY KEY,value TEXT NOT NULL)');
    db.prepare('INSERT INTO worker VALUES(?,?)').run(worker.id,JSON.stringify(worker));
    db.prepare('INSERT INTO cp VALUES(?,?)').run(worker.id,JSON.stringify(checkpoint));
    db.close();
    db=new sqlite.DatabaseSync(dbpath);
    const restoredWorker=JSON.parse((db.prepare('SELECT value FROM worker WHERE id=?')
      .get(worker.id) as {value:string}).value) as FencedWorkerJournalSnapshot;
    const restoredCP=JSON.parse((db.prepare('SELECT value FROM cp WHERE id=?')
      .get(worker.id) as {value:string}).value) as TransferCheckpoint;
    db.close();
    let stage=Buffer.from(binary);
    const reader={
      inspect:async(w:FencedWorkerJournalSnapshot,p:{offset:number;length:number})=>{
        const actual=stage.subarray(p.offset,p.offset+p.length);
        return {kind:'verified' as const,deviceId:w.targetDeviceId,
          offset:p.offset,length:actual.length,sha256:hash(actual)};
      },
    };
    assert.equal((await check(restoredWorker,restoredCP,{stageReadback:reader})).state,
      'readback_verified_not_committed');
    assert.equal(restoredCP.offset,0);
    stage=Buffer.from(stage);
    stage[0]=0xff;
    assert.equal((await check(restoredWorker,restoredCP,{stageReadback:reader})).state,
      'mutation_unknown');
    assert.equal(restoredCP.offset,0);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});


test('deterministic reconnect during delayed readback fences stale socket even with matching ACK UUID and SHA',async()=>{
  const {worker,checkpoint}=rows();
  let releaseReadback!:()=>void;
  let signalEntered!:()=>void;
  const entered=new Promise<void>(r=>{signalEntered=r;});
  const released=new Promise<void>(r=>{releaseReadback=r;});
  let liveEpoch=5;
  let readCount=0;
  const input={
    sessionWitness:{currentEpoch:async()=>liveEpoch},
    stageReadback:{inspect:async (w:FencedWorkerJournalSnapshot,p:{offset:number;length:number;sha256:string})=>{
      readCount++;
      signalEntered();
      await released;
      return {kind:'verified' as const,deviceId:w.targetDeviceId,
        offset:p.offset,length:p.length,sha256:p.sha256};
    }},
  };
  const snapshot=JSON.stringify({worker,checkpoint});
  const pending=check(worker,checkpoint,input);
  await entered; // deterministic barrier, not arbitrary 120ms sleeps
  liveEpoch=6; // new authenticated Broker socket epoch
  releaseReadback();
  const result=await pending;
  assert.equal(result.state,'epoch_stale');
  assert.equal(result.automaticallyReplayable,false);
  assert.equal(result.checkpointAdvanced,false);
  assert.equal(readCount,1);
  assert.equal(JSON.stringify({worker,checkpoint}),snapshot);
  // Old epoch cannot be used to observe or commit the same ACK, even
  // though the stored requestId and SHA are unchanged.
  assert.equal((await check(worker,checkpoint,{sessionWitness:input.sessionWitness})).state,'epoch_stale');
});

test('fresh Broker re-pair epoch with durable pending preserves UNKNOWN; no implicit write dispatch',async()=>{
  const {worker,checkpoint}=rows();
  const oldUuid=worker.pending!.requestId;
  const copy=JSON.stringify({worker,checkpoint});
  // Source-only approximation of an authenticated next-epoch CAS. The
  // actual CAS must be performed by the trusted Connection owner.
  checkpoint.epoch=6;
  assert.equal((await check(worker,checkpoint,{
    route:route(5),sessionWitness:{currentEpoch:async()=>6},
  })).state,'epoch_stale');
  const valid=await check(worker,checkpoint,{
    route:route(6),sessionWitness:{currentEpoch:async()=>6},
  });
  assert.equal(valid.state,'readback_verified_not_committed');
  assert.equal(valid.requestId,oldUuid);
  assert.equal(valid.automaticallyReplayable,false);
  assert.equal(valid.checkpointAdvanced,false);
  assert.equal(checkpoint.offset,0);
  assert.equal(worker.bytesConfirmed,0);
  assert.equal(worker.pending?.requestId,oldUuid);
  assert.notEqual(JSON.stringify({worker,checkpoint}),copy);
});

test('CORE or ROOT revoke during awaited verified readback takes precedence over reconnect approval',async()=>{
  for(const cause of ['core','root'] as const){
    const {worker,checkpoint}=rows();
    let currentGrant=true, signal!:()=>void, release!:()=>void;
    const readEntered=new Promise<void>(r=>{signal=r;});
    const hold=new Promise<void>(r=>{release=r;});
    let grantEpoch=71, rootEpoch=13;
    const access=async()=>{
      if(cause==='core')return currentGrant && grantEpoch===71;
      return currentGrant && rootEpoch===13;
    };
    const pending=check(worker,checkpoint,{
      authorize:access,
      sessionWitness:{currentEpoch:async()=>5},
      stageReadback:{inspect:async(w,p)=>{
        signal();await hold;
        return {kind:'verified' as const,deviceId:w.targetDeviceId,
          offset:p.offset,length:p.length,sha256:p.sha256};
      }},
    });
    await readEntered;
    currentGrant=false;
    if(cause==='core')grantEpoch=72;else rootEpoch=14;
    release();
    const result=await pending;
    assert.equal(result.state,'authority_blocked');
    assert.equal(result.automaticallyReplayable,false);
    assert.equal(checkpoint.offset,0);
    assert.equal(worker.bytesConfirmed,0);
  }
});

test('#667 cancel after native lost ACK cannot turn durable pending into success or replay',async()=>{
  const {worker,checkpoint}=rows();
  const original=worker.pending!.requestId;
  // #667 must preserve pending after a potentially dispatched Native write.
  for(const state of ['MUTATION_UNKNOWN','CANCEL_REQUESTED','CANCELLED'] as const){
    worker.state=state;
    const actual=await check(worker,checkpoint,{
      sessionWitness:{currentEpoch:async()=>5},
    });
    assert.equal(actual.state,state==='MUTATION_UNKNOWN' ?
      'readback_verified_not_committed':'cancel_pending');
    assert.equal(actual.automaticallyReplayable,false);
    assert.equal(actual.checkpointAdvanced,false);
    assert.equal(worker.pending?.requestId,original);
    assert.equal(checkpoint.offset,0);
  }
  const noRead=await check(worker,checkpoint,{
    stageReadback:undefined,sessionWitness:{currentEpoch:async()=>5},
  });
  assert.equal(noRead.state,'cancel_pending');
});

test('Broker epoch witness unavailable, contradictory or foreign route never authenticates a pending chunk',async()=>{
  const {worker,checkpoint}=rows();
  for(const src of [
    {currentEpoch:async()=>undefined},
    {currentEpoch:async()=>4},
    {currentEpoch:async()=>6},
    {currentEpoch:async()=>{throw Error('BROKER_UNREACHABLE')}},
  ]){
    const result=await check(worker,checkpoint,{sessionWitness:src});
    assert.ok(result.state==='authority_blocked'||result.state==='epoch_stale');
    assert.equal(result.automaticallyReplayable,false);
  }
  const foreign=await check(worker,checkpoint,{
    route:{...route(5),destinationDeviceId:'unrelated-agent'},
    sessionWitness:{currentEpoch:async()=>5},
  });
  assert.equal(foreign.state,'journal_mismatch');
});
