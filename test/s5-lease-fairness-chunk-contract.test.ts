/**
 * S5 source contract only. Does not call real #596 lease/worker APIs.
 * Logical job admission is one quota reservation; a 64 KiB chunk is NOT a
 * new authenticated native tool completion nor a provider billable unit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ProposedS5ProtectedTenantAdmission} from '../src/ops/scale-s5-protected-admission.js';
import {S5RollingChunkReceiptAudit,S5_TRANSFER_CHUNK_BYTES}
  from '../src/ops/scale-s5-chunk-receipt-audit.js';

const SCOPE='s5-isolated-lease-proof-01';
const A='owner-noisy-tenant-a';
const B='owner-quiet-tenant-b';
const CHUNK_SHA=createHash('sha256').update('synthetic claimed bytes only').digest('hex');
const INV_SHA=createHash('sha256').update('canonical start transfer').digest('hex');
const NOW=new Date('2026-10-21T12:00:00.000Z');
const fixture=()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync('test/fixtures/s5-protected-share-local.sql','utf8'));
  const admission=new ProposedS5ProtectedTenantAdmission(db,{
    scope:SCOPE,globalRollingMinuteLimit:600,
    tenants:[{tenantId:A,weight:1},{tenantId:B,weight:1}],
  });
  return {db,admission};
};
const identity={accountId:B,transferId:'transfer-quiet-session-01',
  sourceDeviceId:'device-source-quiet',targetDeviceId:'device-target-quiet',
  epoch:10,expectedBytes:10*S5_TRANSFER_CHUNK_BYTES} as const;
const receipt=(offsetBytes:number,epoch=10,accountId:string=B)=>({
  accountId,transferId:identity.transferId,sourceDeviceId:identity.sourceDeviceId,
  targetDeviceId:identity.targetDeviceId,epoch,offsetBytes,
  receivedBytes:S5_TRANSFER_CHUNK_BYTES,senderChunkSha256:CHUNK_SHA,
  receiverChunkSha256:CHUNK_SHA,latencyMs:2.5,
});

test('noisy tenant cannot exhaust protected quiet owner logical-transfer lease quota',()=>{
  const {db,admission}=fixture();
  try{
    for(let i=0;i<600;i++){
      const r=admission.observe(A,'noisy-transfer-request-'+i,INV_SHA,NOW);
      assert.equal(r.status,i<300?'reserved':'tenant-exhausted');
    }
    const accepted=admission.observe(B,'quiet-logical-transfer-start-001',INV_SHA,NOW);
    assert.equal(accepted.status,'reserved');
    assert.equal(accepted.authorizesToolExecution,false);
    const audit=new S5RollingChunkReceiptAudit(identity);
    for(let i=0;i<10;i++){
      assert.equal(audit.record(receipt(i*S5_TRANSFER_CHUNK_BYTES)),
        'RECORDED_UNVERIFIED');
    }
    const repeated=admission.observe(B,'quiet-logical-transfer-start-001',INV_SHA,NOW);
    assert.equal(repeated.status,'duplicate');
    assert.equal(repeated.authorizesToolExecution,false);
    const rows=db.prepare('SELECT tenant_id,COUNT(*) AS n FROM s5_fair_window GROUP BY tenant_id')
      .all() as Array<{tenant_id:string;n:number}>;
    assert.deepEqual(Object.fromEntries(rows.map(r=>[r.tenant_id,r.n])),{[A]:300,[B]:1});
    const result=audit.snapshot();
    assert.equal(result.accountedBytes,10*S5_TRANSFER_CHUNK_BYTES);
    assert.equal(result.accountedChunks,10);
    assert.equal(result.independentlyVerifiedDiskHash,false);
    assert.equal(result.independentlyVerifiedNativeCompletion,false);
    assert.equal(result.actuallyTransferredBytesByThisAudit,0);
  }finally{db.close()}
});

test('wrong account, stale lease epoch, forged receipt and replay mismatch are rejected',()=>{
  const audit=new S5RollingChunkReceiptAudit(identity);
  assert.throws(()=>audit.record(receipt(0,9)),/cross-tenant\/device\/epoch/);
  assert.throws(()=>audit.record(receipt(0,10,A)),/cross-tenant\/device\/epoch/);
  assert.throws(()=>audit.record({...receipt(0),receiverChunkSha256:'b'.repeat(64)}),
    /sha-mismatched/);
  assert.equal(audit.record(receipt(0)),'RECORDED_UNVERIFIED');
  assert.equal(audit.record(receipt(0)),'DUPLICATE_UNVERIFIED');
  assert.throws(()=>audit.record({...receipt(0),senderChunkSha256:'c'.repeat(64)}),
    /sha-mismatched|offset conflict/);
  assert.throws(()=>audit.record(receipt(2*S5_TRANSFER_CHUNK_BYTES)),
    /offset conflict/);
  assert.equal(audit.snapshot().accountedChunks,1);
});

test('quota reservation is not native tool authorization, provider cost or durable job lease',()=>{
  const {db,admission}=fixture();
  try{
    const first=admission.observe(B,'logical-test-start-not-physical',INV_SHA,NOW);
    assert.equal(first.status,'reserved');
    assert.equal(first.authorizesToolExecution,false);
    assert.equal(admission.observe('untrusted-tenant-id','fake-invocation-01',INV_SHA,NOW).status,
      'unknown-tenant');
    const m=new S5RollingChunkReceiptAudit(identity).snapshot();
    assert.equal(m.independentlyVerifiedNativeCompletion,false);
    assert.equal(m.allChunksReported,false);
    // This source contract does not prove any authenticated broker lease.
  }finally{db.close()}
});
