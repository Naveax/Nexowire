import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { IdempotencyStore,operationFingerprint } from '../src/operations/idempotency-store.js';
import { AgentOperationJournal } from '../src/agent/operation-journal.js';
import { fingerprintAgentRequest } from '../src/agent/request-cache.js';
import { reconcileConnectionBoundAgentOperation } from '../src/operations/agent-connection-journal-reconciliation.js';

/** Temporary #06 owner audit, NOT a production regression fix.
 * Journal has no logicalMutationId/ownerEpoch binding for cross-ID aliases. */
test('two cloned runbook session identities map to independent UUIDs; no cross-alias external evidence',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'nwx-06-781-provenance-'));
 const hub=new IdempotencyStore(path.join(root,'hub'));
 const agent=new AgentOperationJournal(path.join(root,'agent.sqlite'));
 t.after(async()=>{agent.close();await rm(root,{recursive:true,force:true});});
 const targetId='fixture-device-06',capability='files.write';
 const payload={path:'/fixture/inert',content:'same-logical-effect'};
 const results=[];
 let ownerEpoch=7;
 let originalOperationId='';
 for(const [index,sessionId] of ['original-runbook','cloned-runbook'].entries()){
  const created=await hub.begin({
   key:sessionId,
   fingerprint:operationFingerprint({targetId,capability,payload}),
   capability,targetId,
  });
  const operationId=created.record.operationId;
  if(!originalOperationId)originalOperationId=operationId;
  else assert.notEqual(operationId,originalOperationId);
  const fp=fingerprintAgentRequest(capability,payload,'safe');
  await agent.begin(operationId,fp,capability);
  await agent.markDispatched(operationId,fp);
  // First dispatch has UNKNOWN outcome, then an independently keyed clone
  // claims success. Neither transport status proves the physical effect.
  await agent.complete(operationId,index===0?'unknown':'succeeded',undefined,
    {kind:'file_write_ack',verified:false},fp);
  await hub.complete(sessionId,'unknown');
  const verdict=reconcileConnectionBoundAgentOperation({
   operationId,expectedDeviceId:targetId,authenticatedDeviceId:targetId,
   capability,payload,hubRecord:await hub.getByOperationId(operationId),
   agentRecord:await agent.inspect(operationId),agentOnline:true,
  });
  results.push(verdict);
  assert.equal(verdict.state,index===0?'unknown':'agent_confirmed');
  assert.equal(verdict.externalSideEffectProven,false);
  assert.equal(verdict.automaticallyRetryable,false);
  ownerEpoch++;
 }
 assert.equal(ownerEpoch,9);
 assert.equal(results.length,2);
 // A mismatched old UUID cannot be substituted as the new operation witness.
 const latest=await hub.getByOperationId(results[1]!.operationId);
 const wrong=reconcileConnectionBoundAgentOperation({
  operationId:results[1]!.operationId,expectedDeviceId:targetId,
  authenticatedDeviceId:targetId,capability,payload,hubRecord:latest,
  agentRecord:await agent.inspect(originalOperationId),agentOnline:true,
 });
 assert.equal(wrong.state,'unknown');
 assert.equal(wrong.reason,'journal_mismatch');
 assert.equal(wrong.automaticallyRetryable,false);
 // Crucially: both separate *matching* journal records passed per-request
 // provenance, despite being the same logical effect across changed session
 // labels and externally rotated ownerEpoch. No stable logicalMutationId,
 // high-water epoch or side-effect readback is available to this adapter.
});
