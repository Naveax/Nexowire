import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {StagingArtifactByteBudget,initArtifactBudgetFixture,
  type ArtifactDurableProofVerifier,
} from '../src/ops/scale-v2-artifact-byte-budget-staging.js';
import {StagingCoreArtifactCancellationGate,
  type ServerBoundQuotaJob,type VerifiedCoreArtifactLease,
  type TrustedCoreArtifactAuthority,
} from '../src/ops/scale-v2-core-artifact-cancel-staging.js';

const binding:ServerBoundQuotaJob={
  ownerId:'owner-signed-high',deviceId:'device-signed-high',
  projectId:'project-alpha',sessionId:'session-alpha-01',
  ownerEpoch:41,deviceEpoch:27,
};
const time=new Date('2026-10-21T12:00:00.000Z');
const later=new Date('2026-10-21T12:00:00.050Z');
const fileSha='a'.repeat(64),chunkSha='b'.repeat(64);
const size=2*65536;
const receipt=(requestId='chunk-alpha-001')=>({
  ownerId:binding.ownerId,deviceId:binding.deviceId,
  projectId:binding.projectId,sessionId:binding.sessionId,
  requestId,offsetBytes:0,byteCount:65536,
  storedSha256:chunkSha,durableStorageVerified:true as const,
});
const chunk=(requestId='chunk-alpha-001')=>({
  ownerId:binding.ownerId,deviceId:binding.deviceId,
  projectId:binding.projectId,sessionId:binding.sessionId,
  requestId,offsetBytes:0,byteCount:65536,
  chunkSha256:chunkSha,now:time,
});
function createFixture(){
  const root=mkdtempSync(path.join(tmpdir(),'quota-14-core-epoch-'));
  const file=path.join(root,'budget.sqlite');
  const x=new DatabaseSync(file),y=new DatabaseSync(file);
  x.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000');
  y.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000');
  initArtifactBudgetFixture(x);
  // Synthetic external authority is separate from SQLite: it does not read
  // authorization from an untrusted user-request body.
  let grantEpoch=binding.ownerEpoch,deviceEpoch=binding.deviceEpoch;
  let grantRevoked=false,tokenIntegrity:'high'|'medium'='high';
  let signed=true,protectedCode=true,mode:'CORE'|'FULL'='CORE',unknown=false;
  const external={fenced:false,deleted:false,confirmedChunk:false};
  const proofs:ArtifactDurableProofVerifier={
    verifyChunk:r=>external.confirmedChunk && r.requestId==='chunk-alpha-001' &&
      r.ownerId===binding.ownerId && r.deviceId===binding.deviceId,
    verifyFinal:()=>false,
    verifyDeletion:r=>external.deleted && r.sessionId===binding.sessionId,
    verifyWriterFence:r=>external.fenced && r.sessionId===binding.sessionId,
  };
  const authority:TrustedCoreArtifactAuthority={
    async withVerifiedCoreLease(scope,apply){
      if(unknown||grantRevoked||scope.ownerEpoch!==grantEpoch||
         scope.deviceEpoch!==deviceEpoch){
        throw Error('CORE_GRANT_STALE_REVOKED_OR_UNKNOWN');
      }
      const verified={
        ...binding,ownerEpoch:grantEpoch,deviceEpoch,
        mode,brokerTokenIntegrity:tokenIntegrity,
        signedBrokerVerified:signed,protectedBrokerVerified:protectedCode,
        delegationCurrent:true,grantRevoked:false,
      } as unknown as VerifiedCoreArtifactLease;
      return apply(verified);
    },
  };
  const first=new StagingArtifactByteBudget(x,undefined,proofs);
  const second=new StagingArtifactByteBudget(y,undefined,proofs);
  const gate=new StagingCoreArtifactCancellationGate(first,authority);
  const totals=()=>{
    const q=(sql:string)=>Number(
      (x.prepare(sql).get() as {n:number}|undefined)?.n??0);
    return {
      bytes:q('SELECT COALESCE(SUM(byte_count),0) AS n FROM budget_artifact_chunks'),
      occupied:q("SELECT COALESCE(SUM(size_bytes),0) AS n FROM budget_artifact_sessions WHERE state<>'RELEASED'"),
      chunks:q('SELECT COUNT(*) AS n FROM budget_artifact_chunks'),
    };
  };
  return {
    first,second,gate,authority,external,totals,
    setOwnerEpoch(x:number){grantEpoch=x},
    setDeviceEpoch(x:number){deviceEpoch=x},
    revoke(){grantRevoked=true},clearUnknown(){unknown=false},
    unknown(){unknown=true},setIntegrity(x:'high'|'medium'){tokenIntegrity=x},
    setSigned(x:boolean){signed=x},setProtected(x:boolean){protectedCode=x},
    setMode(x:'CORE'|'FULL'){mode=x},
    close(){y.close();x.close();rmSync(root,{recursive:true,force:true})},
  };
}
const open=()=>({...binding,rootInvocationId:'root-alpha-01',
  sizeBytes:size,sourceSha256:fileSha,physicalFreeBytes:4*1024**3,now:time});
const removed=()=>({...binding,sessionId:binding.sessionId,
  durableDeletionVerified:true as const,writersStoppedVerified:true as const});
async function rejects(fn:()=>Promise<unknown>,re:RegExp){
  await assert.rejects(fn,re);
}

test('no independently owned CORE authority: cancellation is denied before touching staged bytes',async()=>{
  const f=createFixture();try{
    assert.equal(f.first.begin(open()),'RESERVED');
    const noAuthority=new StagingCoreArtifactCancellationGate(f.first,undefined);
    await rejects(()=>noAuthority.cancel(binding,0),/CORE_TRUST_AUTHORITY_REQUIRED/);
    assert.deepEqual(f.totals(),{bytes:0,occupied:size,chunks:0});
  }finally{f.close()}
});
test('medium integrity, unsigned broker, unprotected broker and FULL preferences do not authorize CORE',async()=>{
  const f=createFixture();try{
    assert.equal(f.first.begin(open()),'RESERVED');
    f.setIntegrity('medium');
    await rejects(()=>f.gate.cancel(binding,0),/CORE_CANCEL_EFFECTIVE_PROOF_INVALID/);
    f.setIntegrity('high');f.setSigned(false);
    await rejects(()=>f.gate.cancel(binding,0),/CORE_CANCEL_EFFECTIVE_PROOF_INVALID/);
    f.setSigned(true);f.setProtected(false);
    await rejects(()=>f.gate.cancel(binding,0),/CORE_CANCEL_EFFECTIVE_PROOF_INVALID/);
    f.setProtected(true);f.setMode('FULL');
    await rejects(()=>f.gate.cancel(binding,0),/CORE_CANCEL_EFFECTIVE_PROOF_INVALID/);
    assert.equal(f.first.begin(open()),'ALREADY_RESERVED');
  }finally{f.close()}
});
test('CORE cancellation is bound to exact trusted owner/device/project/session',async()=>{
  const f=createFixture();try{
    assert.equal(f.first.begin(open()),'RESERVED');
    for(const bad of [
      {...binding,ownerId:'foreign-owner'},
      {...binding,deviceId:'repaired-device'},
      {...binding,projectId:'foreign-project'},
      {...binding,sessionId:'foreign-session'},
    ]){
      await rejects(()=>f.gate.cancel(bad,0),/CORE_CANCEL_EFFECTIVE_PROOF_INVALID/);
    }
    assert.equal(await f.gate.cancel(binding,0),'CANCEL_PENDING');
    assert.equal(await f.gate.cancel(binding,0),'ALREADY_CANCEL_PENDING');
  }finally{f.close()}
});
test('old owner delegation epoch and replaced device epoch cannot act after re-pair',async()=>{
  const f=createFixture();try{
    assert.equal(f.first.begin(open()),'RESERVED');
    f.setOwnerEpoch(42);
    await rejects(()=>f.gate.cancel(binding,0),/CORE_GRANT_STALE_REVOKED_OR_UNKNOWN/);
    f.setOwnerEpoch(binding.ownerEpoch);f.setDeviceEpoch(28);
    await rejects(()=>f.gate.cancel(binding,0),/CORE_GRANT_STALE_REVOKED_OR_UNKNOWN/);
    f.setDeviceEpoch(binding.deviceEpoch);
    assert.equal(await f.gate.cancel(binding,0),'CANCEL_PENDING');
    assert.deepEqual(f.totals(),{bytes:0,occupied:size,chunks:0});
  }finally{f.close()}
});
test('UNKNOWN, revoked CORE, and untrusted cancellation booleans never reclaim storage',async()=>{
  const f=createFixture();try{
    assert.equal(f.first.begin(open()),'RESERVED');
    assert.equal(f.first.stageChunk(chunk()),'CHUNK_PENDING');
    f.unknown();
    await rejects(()=>f.gate.cancel(binding,0),/CORE_GRANT_STALE_REVOKED_OR_UNKNOWN/);
    f.clearUnknown();
    assert.equal(await f.gate.cancel(binding,0),'CANCEL_PENDING');
    f.revoke();
    const proof=removed();
    assert.throws(()=>f.first.acknowledgeDeletion(proof),
      /TRUSTED_DELETION_EVIDENCE_REQUIRED/);
    f.external.deleted=true;
    assert.throws(()=>f.first.acknowledgeDeletion(proof),
      /TRUSTED_WRITER_FENCE_REQUIRED/);
    assert.deepEqual(f.totals(),{bytes:65536,occupied:size,chunks:1});
  }finally{f.close()}
});
test('#596/#616-shaped stream receipt forged after cancellation cannot advance offset or refund epoch debit',async()=>{
  const f=createFixture();try{
    assert.equal(f.first.begin(open()),'RESERVED');
    const c=chunk(),r=receipt();
    assert.equal(f.second.stageChunk(c),'CHUNK_PENDING');
    // Receipt boolean from an untrusted worker without independent proof.
    assert.throws(()=>f.first.commitChunk(r),/TRUSTED_CHUNK_EVIDENCE_REQUIRED/);
    assert.equal(await f.gate.cancel(binding,0),'CANCEL_PENDING');
    f.external.confirmedChunk=true; // delayed authentic ACK arrives after tombstone
    assert.equal(f.second.commitChunk(r),'DENIED_STATE');
    assert.equal(f.second.stageChunk({...c,now:later}),'DENIED_STATE');
    assert.equal(f.second.stageChunk({...c,requestId:'chunk-alpha-002',now:later}),
      'DENIED_STATE');
    assert.deepEqual(f.totals(),{bytes:65536,occupied:size,chunks:1});
  }finally{f.close()}
});
test('#605 lost ACK then new connection: single admitted chunk and one durable committed offset',async()=>{
  const f=createFixture();try{
    assert.equal(f.first.begin(open()),'RESERVED');
    const c=chunk(),r=receipt();
    assert.equal(f.first.stageChunk(c),'CHUNK_PENDING');
    f.external.confirmedChunk=true;
    assert.equal(f.second.commitChunk(r),'CHUNK_COMMITTED');
    // ACK lost; new Hub/connection retries only already committed request.
    assert.equal(f.first.stageChunk({...c,now:later}),'CHUNK_ALREADY_COMMITTED');
    assert.equal(f.first.commitChunk(r),'CHUNK_ALREADY_COMMITTED');
    assert.equal(await f.gate.cancel(binding,65536),'CANCEL_PENDING');
    assert.deepEqual(f.totals(),{bytes:65536,occupied:size,chunks:1});
    f.external.deleted=true;f.external.fenced=true;
    assert.equal(f.second.acknowledgeDeletion(removed()),'RELEASED');
    assert.equal(f.first.acknowledgeDeletion(removed()),'RELEASED');
    assert.deepEqual(f.totals(),{bytes:65536,occupied:0,chunks:1});
  }finally{f.close()}
});
test('owner B retains independent admission during cancellation; no epoch refund and stale root never reopens',async()=>{
  const f=createFixture();try{
    assert.equal(f.first.begin(open()),'RESERVED');
    assert.equal(f.first.stageChunk(chunk()),'CHUNK_PENDING');
    assert.equal(await f.gate.cancel(binding,0),'CANCEL_PENDING');
    const other={ownerId:'owner-beta-01',deviceId:'device-beta-01',projectId:'project-beta-01',
      sessionId:'session-beta-01'};
    assert.equal(f.second.begin({...other,rootInvocationId:'root-beta-01',
      sizeBytes:size,sourceSha256:fileSha,physicalFreeBytes:4*1024**3,now:later}),
      'RESERVED');
    f.external.deleted=true;f.external.fenced=true;
    assert.equal(f.first.acknowledgeDeletion(removed()),'RELEASED');
    assert.equal(f.first.begin({...open(),now:later}),'DENIED_STATE');
    assert.deepEqual(f.totals(),{bytes:65536,occupied:size,chunks:1});
  }finally{f.close()}
});
