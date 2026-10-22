import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { projectTaskEvidence, type TaskEvidenceScope } from '../src/coding/task-evidence-projection.js';

const scope: TaskEvidenceScope = Object.freeze({
  ownerId: 'owner-a', deviceId: 'device-a', taskId: 'task-45',
  worktreeId: 'wt-45', sourceSha: 'a'.repeat(40),
  logicalMutationId: 'logical-immutable-45', requestId: 'request-immutable-45',
  ownerEpoch: 7, issuerEpoch: 9,
});
const viewer = {ownerId: scope.ownerId, deviceId: scope.deviceId};
const receipt = {...scope, issuerKeyId: 'issuer-9', receiptId: 'receipt-1',
  signature: 'FAKE_SIGNATURE', verified: true, status: 'COMPLETED_VERIFIED',
  bearerToken: 'TOP_SECRET_RECEIPT_TOKEN'};
const cas = {...scope, issuerKeyId: 'issuer-9', witnessId: 'cas-1',
  status: 'committed', verified: true, bearerToken: 'TOP_SECRET_CAS_TOKEN'};

async function tempFixture(t: import('node:test').TestContext, rows: unknown[]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nw45-evidence-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  const file = path.join(directory, 'audit.jsonl');
  await writeFile(file, rows.map(x => JSON.stringify(x)).join('\n')+'\n');
  return (await readFile(file, 'utf8')).trim().split('\n').map(x => JSON.parse(x) as unknown);
}

test('forged successful AuditLog never turns UNKNOWN into completion or CORE', async t => {
  const auditRows = await tempFixture(t, [
    {operationId:'op-45',targetId:scope.deviceId,status:'succeeded',
      message:'Authorization: Bearer SUPERSECRET_LOG',password:'DO_NOT_EXPORT'},
    {operationId:'op-45',targetId:scope.deviceId,status:'unknown'},
  ]);
  const result = projectTaskEvidence({scope,viewer,auditOperationId:'op-45',
    auditRows,journal:{requestId:scope.requestId,status:'unknown'},
    progress:{...scope,status:'completed_verified',stdout:'DO_NOT_EXPORT'},
    signedIssuerReceipt:receipt,externalCasWitness:cas});
  assert.equal(result.status,'UNKNOWN');
  assert.equal(result.audit.succeeded,1);
  assert.equal(result.receipt,'UNVERIFIED_CLAIM');
  assert.equal(result.externalCas,'UNVERIFIED_CLAIM');
  assert.equal(result.completedVerified,false);
  assert.equal(result.coreEffective,false);
  assert.equal(result.mayDispatch,false);
  assert.equal(result.progress,'UNTRUSTED_REPORT');
  assert.doesNotMatch(JSON.stringify(result),/SUPERSECRET|DO_NOT_EXPORT|TOP_SECRET|FAKE_SIGNATURE|Bearer/);
});

test('stale source SHA and owner epoch invalidate receipt and CAS, never promote journal success', async t => {
  await tempFixture(t,[{operationId:'op-45',targetId:'device-a',status:'succeeded'}]);
  const stale = projectTaskEvidence({scope,viewer,
    journal:{requestId:scope.requestId,status:'succeeded'},
    signedIssuerReceipt:{...receipt,sourceSha:'b'.repeat(40)},
    externalCasWitness:{...cas,ownerEpoch:6}});
  assert.equal(stale.status,'SUCCEEDED_UNVERIFIED');
  assert.equal(stale.receipt,'SCOPE_MISMATCH');
  assert.equal(stale.externalCas,'SCOPE_MISMATCH');
  assert.equal(stale.completedVerified,false);
});

test('cross-device and cross-owner callers see constant-shape denial, no correlation leakage', async t => {
  const auditRows = await tempFixture(t, [
    {operationId:'op-45',targetId:'device-b',status:'succeeded',secret:'NEVER_EXPORT'},
    {operationId:'op-45',targetId:'device-a',status:'failed'},
  ]);
  const args = {scope,auditRows,auditOperationId:'op-45',journal:{requestId:scope.requestId,status:'unknown'},
    signedIssuerReceipt:receipt,externalCasWitness:cas};
  const denied = projectTaskEvidence({...args,viewer:{ownerId:scope.ownerId,deviceId:'device-b'}});
  const deniedOwner = projectTaskEvidence({...args,viewer:{ownerId:'owner-b',deviceId:scope.deviceId}});
  assert.deepEqual(denied,deniedOwner);
  assert.equal(denied.status,'ACCESS_DENIED');
  assert.equal(denied.identity,undefined);
  assert.deepEqual(denied.audit,{started:0,succeeded:0,failed:0,unknown:0});
  const allowed = projectTaskEvidence({...args,viewer});
  assert.equal(allowed.audit.failed,1);
  assert.equal(allowed.audit.succeeded,0);
  assert.doesNotMatch(JSON.stringify(allowed),/NEVER_EXPORT|device-b/);
});

test('missing journal or unknown request correlation stays unverified despite successful audit', () => {
  const base = {scope,viewer,auditOperationId:'op-45',auditRows:[
    {operationId:'op-45',targetId:'device-a',status:'succeeded'}]};
  assert.equal(projectTaskEvidence(base).status,'NOT_ESTABLISHED');
  assert.equal(projectTaskEvidence({...base,journal:{requestId:'request-clone',status:'succeeded'}}).status,
    'CORRELATION_CONFLICT');
  assert.equal(projectTaskEvidence({...base,journal:{requestId:scope.requestId,status:'succeeded'}}).completedVerified,false);
});

test('malformed scope blocks export; mutable serialized proof flags do not confer trust', () => {
  const invalid = projectTaskEvidence({scope:{...scope,sourceSha:'not-a-sha'},viewer,
    signedIssuerReceipt:receipt,externalCasWitness:cas});
  assert.equal(invalid.status,'ACCESS_DENIED');
  const result = projectTaskEvidence({scope,viewer,externalCasWitness:{...cas,status:'revoked'},
    signedIssuerReceipt:{...receipt,requestId:'request-clone'}});
  assert.equal(result.externalCas,'REVOKED_CLAIM');
  assert.equal(result.receipt,'SCOPE_MISMATCH');
  assert.equal(result.mayDispatch,false);
});
