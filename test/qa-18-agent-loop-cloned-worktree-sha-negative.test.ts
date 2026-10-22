/**
 * #18 P0 one additive hostile NEGATIVE against #783 ACTUAL read-only API.
 *
 * Do not interpret a PASS as production replay/dispatch authorization:
 * reviewAgentLoopContinuation always returns mayDispatch:false.
 *
 * A previously dispatched, ACK-unknown mutation is copied into a different
 * Git worktree/runbook; requestId + logicalMutationId remain intact, but
 * sourceSha is replaced while remote owner epoch has independently advanced
 * and revoke-start may have occurred. Actual #783 does NOT bind sourceSha
 * immutably and has NO externally authenticated current epoch/readback input.
 * This fixture only demonstrates that source SHA drift is not classified as
 * SCOPE_MISMATCH/STOP; it cannot infer real revocation or OS effect.
 *
 * No filesystem, process, network, Hub, Broker, DB, VM or real CAS calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
 AgentLoopCheckpointV1Schema,reviewAgentLoopContinuation,
} from '../src/agent/agent-loop-journal-contract.js';

test('#18 NEGATIVE: cloned worktree sourceSha drift during lost-ACK UNKNOWN/revoke-start lacks immutable-source STOP classification',()=>{
 const original=AgentLoopCheckpointV1Schema.parse({
  version:1,taskId:'build-app',stepId:'mutate-file',
  logicalMutationId:randomUUID(),
  runbookId:'original-worktree-runbook',
  requestId:randomUUID(),fingerprint:'f'.repeat(64),
  capability:'files.write',ownerId:randomUUID(),deviceId:randomUUID(),
  deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),
  ownerEpoch:17,grantGeneration:25,sourceSha:'a'.repeat(40),
  state:'DISPATCH_MAY_HAVE_OCCURRED',
  originalErrorCode:'MUTATION_STATE_UNKNOWN',
 });
 const cloned=AgentLoopCheckpointV1Schema.parse({
  ...original,
  runbookId:'copied-worktree-runbook',
  sourceSha:'b'.repeat(40), // altered source tree for SAME mutation
 });
 // Remote events are deliberately NOT passed to #783's pure source API.
 // This is an unmet external-evidence dependency, NOT a real CAS witness.
 const independentTruthNeeded={
  revokeStarted:true,currentOwnerEpoch:18,externalReadbackAvailable:false,
 };
 let externalReadbackCount=0;
 assert.equal(independentTruthNeeded.revokeStarted,true);
 assert.notEqual(independentTruthNeeded.currentOwnerEpoch,original.ownerEpoch);
 assert.equal(independentTruthNeeded.externalReadbackAvailable,false);
 assert.equal(cloned.logicalMutationId,original.logicalMutationId);
 assert.equal(cloned.requestId,original.requestId);
 assert.notEqual(cloned.sourceSha,original.sourceSha);

 // Local Agent status "failed" is NOT trustworthy proof of no OS effect:
 // a preceding ACK loss was already recorded in the immutable checkpoint.
 const decision=reviewAgentLoopContinuation(cloned,original,{
  requestId:original.requestId,fingerprint:original.fingerprint,
  capability:original.capability,status:'failed',
  dispatchedAt:'2026-10-22T15:35:00.000Z',evidenceVerified:false,
 });
 // Source-negative observation: sourceSha is missing from #783's
 // immutableFields, so altered worktree passes immutable-scope comparison.
 assert.equal(decision.state,'RECONCILE_REQUIRED');
 assert.equal(decision.reason,'UNKNOWN_OR_POSSIBLY_DISPATCHED');
 assert.notEqual(decision.nextAction,'STOP',
  'UNSAFE CLASSIFICATION: changed source SHA not flagged as scope mismatch');
 assert.equal(decision.originalErrorCode,'MUTATION_STATE_UNKNOWN');
 assert.equal(decision.logicalMutationId,original.logicalMutationId);
 assert.equal(decision.requestId,original.requestId);
 // Current API is READ-ONLY. Do not claim actual OS replay or fake approval.
 assert.equal(decision.mayDispatch,false);
 assert.equal(decision.mayReplay,false);
 assert.equal(decision.completedVerified,false);
 assert.equal(externalReadbackCount,0,
  'No independent owner-epoch/revoke readback was supplied by this API');
});
