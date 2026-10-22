import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {TransferCheckpoint, TransferBinding, AuthenticatedTransferRoute} from '../src/mcp/cross-device-transfer-continuity.js';
import {
  inspectOneCallWorkerConnectionJournal,
  type FencedWorkerJournalSnapshot, type BrokerOwnerEpochChallenge,
} from '../src/mcp/cross-device-worker-journal-link.js';

const source=Buffer.alloc(65536,0x74);
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const uuid=()=>randomUUID();
function fixture(){
  const binding:TransferBinding={
    jobId:uuid(),ownerId:'owner-06',projectId:'Nexowire',
    sourceDeviceId:'workpc-fixture',destinationDeviceId:'naveax-fixture',
    sourcePath:'/synthetic/from.bin',targetPath:'/synthetic/to.bin',
    stagePath:'/synthetic/to.bin.nexowire-upload-staging',
    sourceSha256:sha(source),totalBytes:source.length,
  };
  const requestId=uuid();
  const checkpoint:TransferCheckpoint={
    binding,revision:17,epoch:5,offset:0,status:'unknown',
    pending:{requestId,epoch:4,offset:0,length:source.length,
      sha256:sha(source),ackObserved:false},
  };
  const worker:FencedWorkerJournalSnapshot={
    id:binding.jobId,accountId:binding.ownerId,projectId:binding.projectId,
    sourceDeviceId:binding.sourceDeviceId,targetDeviceId:binding.destinationDeviceId,
    sourcePath:binding.sourcePath,targetPath:binding.targetPath,stagePath:binding.stagePath,
    bytesTotal:binding.totalBytes,bytesConfirmed:0,sha256:binding.sourceSha256,
    errorCode:'FORGED_WRITE_RECEIPT',
    state:'MUTATION_UNKNOWN',
    fencing:{epoch:21,token:'fixture-external-lease-token-1234567890'},
    pending:{requestId,epoch:21,offset:0,length:source.length,sha256:sha(source),
      dispatched:true},
  };
  const route:AuthenticatedTransferRoute={
    ownerId:binding.ownerId,projectId:binding.projectId,
    sourceDeviceId:binding.sourceDeviceId,destinationDeviceId:binding.destinationDeviceId,
    epoch:5,
  };
  const owner={
    ownerEpoch:9,grantGeneration:41,
    deviceEpoch:uuid(),sessionEpoch:uuid(),
    privilege:'CORE' as 'CORE'|'ROOT',
  };
  return {worker,checkpoint,route,owner};
}
type Input=Parameters<typeof inspectOneCallWorkerConnectionJournal>[0];
const run=(f:ReturnType<typeof fixture>,changes:Partial<Input>={})=>
  inspectOneCallWorkerConnectionJournal({
    worker:f.worker,checkpoint:f.checkpoint,route:f.route,
    ownerAdmission:f.owner,
    authorize:async()=>true,
    workerLease:{check:async()=>true},
    sessionWitness:{currentEpoch:async r=>r.epoch},
    ownerEpochWitness:{assertFresh:async c=>c.ownerId===f.worker.accountId &&
      c.deviceId===f.worker.targetDeviceId &&
      c.ownerEpoch===f.owner.ownerEpoch &&
      c.grantGeneration===f.owner.grantGeneration &&
      /^[a-f0-9]{64}$/.test(c.challengeNonce)},
    stageReadback:{inspect:async (w,p)=>({
      kind:'verified' as const,deviceId:w.targetDeviceId,
      offset:p.offset,length:p.length,sha256:p.sha256,
    })},...changes,
  });

test('#725 forensic forged-ACK error and UNKNOWN pending survive read-only verified observation',async()=>{
  const f=fixture();
  const before=JSON.stringify(f);
  const out=await run(f);
  assert.equal(out.state,'readback_verified_not_committed');
  assert.equal(out.requestId,f.worker.pending?.requestId);
  assert.equal(out.automaticallyReplayable,false);
  assert.equal(out.mutationExecuted,false);
  assert.equal(out.checkpointAdvanced,false);
  assert.equal(out.externalSideEffectProven,false);
  assert.equal(f.worker.errorCode,'FORGED_WRITE_RECEIPT');
  assert.equal(f.worker.state,'MUTATION_UNKNOWN');
  assert.equal(f.checkpoint.offset,0);
  assert.equal(JSON.stringify(f),before);
});

test('#712 current ownerEpoch and grantGeneration revalidate after readback; cryptographic challenges are distinct',async()=>{
  const f=fixture();
  const observed:BrokerOwnerEpochChallenge[]=[];
  let currentOwnerEpoch=9, currentGeneration=41;
  let entered!:()=>void, release!:()=>void;
  const gated=new Promise<void>(r=>{entered=r;});
  const resume=new Promise<void>(r=>{release=r;});
  const pending=run(f,{
    ownerEpochWitness:{assertFresh:async c=>{
      observed.push(c);
      return c.ownerEpoch===currentOwnerEpoch &&
        c.grantGeneration===currentGeneration;
    }},
    stageReadback:{inspect:async(w,p)=>{
      entered();await resume;
      return {kind:'verified' as const,deviceId:w.targetDeviceId,
        offset:p.offset,length:p.length,sha256:p.sha256};
    }},
  });
  await gated;
  currentOwnerEpoch=10;
  currentGeneration=42;
  release();
  const out=await pending;
  assert.equal(out.state,'authority_blocked');
  assert.equal(out.checkpointAdvanced,false);
  assert.equal(f.worker.errorCode,'FORGED_WRITE_RECEIPT');
  assert.equal(f.checkpoint.offset,0);
  assert.equal(observed.length,2);
  const first=observed[0]!, second=observed[1]!;
  assert.match(first.challengeNonce,/^[a-f0-9]{64}$/);
  assert.match(second.challengeNonce,/^[a-f0-9]{64}$/);
  assert.notEqual(first.challengeNonce,second.challengeNonce,
    'a replayed signed claim from WAL cannot satisfy a fresh nonce');
});

test('old signed nonce, wrong device and owner epoch cannot be mistaken for present #712 proof',async()=>{
  const f=fixture();
  let oldNonce:string|undefined;
  const replayer={
    assertFresh:async (c:BrokerOwnerEpochChallenge)=>{
      if(oldNonce===undefined){oldNonce=c.challengeNonce;return true;}
      return c.challengeNonce===oldNonce; // forged replay from old WAL
    },
  };
  assert.equal((await run(f,{ownerEpochWitness:replayer})).state,
    'authority_blocked');
  assert.equal(f.checkpoint.offset,0);
  const wrongDevice=await run(f,{
    ownerEpochWitness:{assertFresh:async c=>c.deviceId==='different-agent'},
  });
  assert.equal(wrongDevice.state,'authority_blocked');
  const wrongOwnerEpoch=await run(f,{
    ownerEpochWitness:{assertFresh:async c=>c.ownerEpoch===10},
  });
  assert.equal(wrongOwnerEpoch.state,'authority_blocked');
});

test('two reconnects and persistent reopened UNKNOWN never yield implicit dispatch or offset credit',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nw-06-double-reconnect-'));
  t.after(async()=>fs.rm(dir,{recursive:true,force:true}));
  const f=fixture();
  const dbpath=path.join(dir,'state.sqlite');
  let db=new DatabaseSync(dbpath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE snapshots (k TEXT PRIMARY KEY,v TEXT NOT NULL)');
  db.prepare('INSERT INTO snapshots(k,v) VALUES(?,?)').run('worker',JSON.stringify(f.worker));
  db.prepare('INSERT INTO snapshots(k,v) VALUES(?,?)').run('cp',JSON.stringify(f.checkpoint));
  db.close();
  db=new DatabaseSync(dbpath);
  const get=(k:string)=>JSON.parse((db.prepare('SELECT v FROM snapshots WHERE k=?').get(k) as {v:string}).v);
  const restored={...f,worker:get('worker') as FencedWorkerJournalSnapshot,
    checkpoint:get('cp') as TransferCheckpoint};
  db.close();
  const requestId=f.worker.pending!.requestId;
  let liveEpoch=6; // first disconnect and successful trusted broker re-pair
  let stageReads=0;
  const changes:Partial<Input>={
    sessionWitness:{currentEpoch:async()=>liveEpoch},
    stageReadback:{inspect:async(w,p)=>{
      stageReads++;
      return {kind:'verified' as const,deviceId:w.targetDeviceId,
        offset:p.offset,length:p.length,sha256:p.sha256};
    }},
  };
  assert.equal((await run(restored,changes)).state,'epoch_stale');
  restored.checkpoint.epoch=6;restored.route.epoch=6;
  const afterFirst=await run(restored,changes);
  assert.equal(afterFirst.state,'readback_verified_not_committed');
  assert.equal(afterFirst.checkpointAdvanced,false);
  liveEpoch=7; // second reconnect, old ACK is still not an authority
  assert.equal((await run(restored,changes)).state,'epoch_stale');
  restored.checkpoint.epoch=7;restored.route.epoch=7;
  const afterSecond=await run(restored,changes);
  assert.equal(afterSecond.state,'readback_verified_not_committed');
  assert.equal(afterSecond.automaticallyReplayable,false);
  assert.equal(afterSecond.requestId,requestId);
  assert.equal(restored.checkpoint.offset,0);
  assert.equal(restored.worker.bytesConfirmed,0);
  assert.equal(restored.worker.pending?.requestId,requestId);
  assert.equal(restored.worker.errorCode,'FORGED_WRITE_RECEIPT');
  assert.equal(stageReads,2);
});

test('orphan pending after restart with no matching #613 intent stays journal mismatch',async()=>{
  const f=fixture();
  f.checkpoint.pending=undefined;
  const out=await run(f);
  assert.equal(out.state,'journal_mismatch');
  assert.equal(out.automaticallyReplayable,false);
  assert.equal(out.checkpointAdvanced,false);
  assert.equal(out.verifiedPrefixBytes,0);
  assert.equal(f.worker.pending?.dispatched,true);
  assert.equal(f.worker.state,'MUTATION_UNKNOWN');
});

test('revoke during readback and concurrent cancel preserve #725 forensic UNKNOWN',async()=>{
  const f=fixture();
  let atRead!:()=>void,release!:()=>void;
  const began=new Promise<void>(r=>{atRead=r;});
  const gate=new Promise<void>(r=>{release=r;});
  let grantActive=true;
  const pending=run(f,{
    authorize:async()=>grantActive,
    stageReadback:{inspect:async (w,p)=>{
      atRead();await gate;
      return {kind:'verified' as const,deviceId:w.targetDeviceId,
        offset:p.offset,length:p.length,sha256:p.sha256};
    }},
  });
  await began;
  grantActive=false;
  f.worker.state='CANCEL_REQUESTED';
  release();
  const result=await pending;
  assert.equal(result.state,'authority_blocked');
  assert.equal(result.automaticallyReplayable,false);
  assert.equal(f.worker.pending?.dispatched,true);
  assert.equal(f.worker.errorCode,'FORGED_WRITE_RECEIPT');
  assert.equal(f.checkpoint.offset,0);
});


test('ROOT session epoch replacement during readback rejects a new signed permit for old session',async()=>{
  const f=fixture();
  f.owner.privilege='ROOT';
  let currentSession=f.owner.sessionEpoch;
  let entered!:()=>void,release!:()=>void;
  const began=new Promise<void>(r=>{entered=r;});
  const gate=new Promise<void>(r=>{release=r;});
  const pending=run(f,{
    ownerEpochWitness:{assertFresh:async c=>
      c.privilege==='ROOT' && c.sessionEpoch===currentSession &&
      c.grantGeneration===41},
    stageReadback:{inspect:async(w,p)=>{
      entered();await gate;
      return {kind:'verified' as const,deviceId:w.targetDeviceId,
        offset:p.offset,length:p.length,sha256:p.sha256};
    }},
  });
  await began;
  currentSession=uuid();
  release();
  const out=await pending;
  assert.equal(out.state,'authority_blocked');
  assert.equal(out.automaticallyReplayable,false);
  assert.equal(f.worker.state,'MUTATION_UNKNOWN');
  assert.equal(f.worker.errorCode,'FORGED_WRITE_RECEIPT');
  assert.equal(f.checkpoint.offset,0);
});


test('orphaned Native UNKNOWN is never a healthy prefix when BOTH pending envelopes disappear',async()=>{
  const f=fixture();
  const requestId=f.worker.pending!.requestId;
  // Simulate damaged/legacy worker and Connection records after a crash.
  // The durable forensic status, not equal offsets, controls safety.
  f.worker.pending=undefined;
  f.checkpoint.pending=undefined;
  f.checkpoint.status='unknown';
  const out=await run(f);
  assert.equal(out.state,'mutation_unknown');
  assert.equal(out.automaticallyReplayable,false);
  assert.equal(out.checkpointAdvanced,false);
  assert.equal(out.mutationExecuted,false);
  assert.equal(f.worker.errorCode,'FORGED_WRITE_RECEIPT');
  assert.equal(f.worker.bytesConfirmed,0);
  assert.equal(f.checkpoint.offset,0);
  assert.ok(requestId);
});

test('orphan status matrix: FAILURE/RECOVERY/PUBLISHING never look dispatchable',async()=>{
  for(const state of ['MUTATION_UNKNOWN','RECOVERY_REQUIRED','FAILED','PUBLISHING',
    'CANCELLED','CANCEL_REQUESTED','QUEUED'] as const){
    const f=fixture();
    f.worker.state=state;
    f.worker.pending=undefined;
    f.checkpoint.pending=undefined;
    f.checkpoint.status='ready';
    const out=await run(f);
    const expected=state==='PUBLISHING' ? 'unverified_completion':
      (state==='CANCELLED'||state==='CANCEL_REQUESTED')?'cancel_pending':
      state==='QUEUED'?'prefix_consistent':'mutation_unknown';
    assert.equal(out.state,expected,state);
    assert.equal(out.automaticallyReplayable,false);
    assert.equal(out.mutationExecuted,false);
    assert.equal(out.checkpointAdvanced,false);
    assert.equal(out.externalSideEffectProven,false);
  }
});

test('SQLite WAL orphan UNKNOWN survives two authenticated reconnect epochs without replay',async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'nw-06-orphan-742-'));
  t.after(async()=>fs.rm(folder,{recursive:true,force:true}));
  const original=fixture();
  original.worker.pending=undefined;
  original.checkpoint.pending=undefined;
  original.checkpoint.status='unknown';
  const database=path.join(folder,'persisted.sqlite');
  let db=new DatabaseSync(database);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE journal(k TEXT PRIMARY KEY,v TEXT NOT NULL)');
  db.prepare('INSERT INTO journal VALUES (?,?)').run('worker',JSON.stringify(original.worker));
  db.prepare('INSERT INTO journal VALUES (?,?)').run('connection',JSON.stringify(original.checkpoint));
  db.close();
  db=new DatabaseSync(database);
  const get=(k:string)=>JSON.parse((db.prepare('SELECT v FROM journal WHERE k=?').get(k) as {v:string}).v);
  const restored={...original,
    worker:get('worker') as FencedWorkerJournalSnapshot,
    checkpoint:get('connection') as TransferCheckpoint};
  db.close();
  let sessionEpoch=5;
  let ownerEpoch=original.owner.ownerEpoch;
  let readbacks=0;
  const overrides:Partial<Input>={
    sessionWitness:{currentEpoch:async()=>sessionEpoch},
    ownerEpochWitness:{assertFresh:async c=>c.ownerEpoch===ownerEpoch &&
      c.grantGeneration===original.owner.grantGeneration &&
      c.sessionEpoch===original.owner.sessionEpoch},
    stageReadback:{inspect:async(w,p)=>{
      readbacks++;
      return {kind:'verified' as const,deviceId:w.targetDeviceId,
        offset:p.offset,length:p.length,sha256:p.sha256};
    }},
  };
  for(const next of [5,6,7]){
    sessionEpoch=next;
    // Synthetic authorized re-pair: represents separately accepted CAS;
    // this read-only module does not change the persisted records itself.
    if(next!==5){
      assert.equal((await run(restored,overrides)).state,'epoch_stale');
      restored.route.epoch=next;
      restored.checkpoint.epoch=next;
    }
    const proof=await run(restored,overrides);
    assert.equal(proof.state,'mutation_unknown');
    assert.equal(proof.automaticallyReplayable,false);
    assert.equal(proof.checkpointAdvanced,false);
    assert.equal(restored.checkpoint.offset,0);
    assert.equal(restored.worker.bytesConfirmed,0);
  }
  ownerEpoch++;
  assert.equal((await run(restored,overrides)).state,'authority_blocked');
  assert.equal(readbacks,0,'orphan cannot reach readback, let alone replay');
  assert.equal(restored.worker.errorCode,'FORGED_WRITE_RECEIPT');
});
