import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyClientToolInterruption,
  planToolWorkflowContinuation,
  validateToolWorkflowCheckpoint,
  type ToolWorkflowCheckpoint,
} from '../src/protocol/tool-interruption-recovery.js';

const sha = 'a'.repeat(64);
function fixture(): ToolWorkflowCheckpoint {
  return {version: 1, workflowId: 'nexowire-13-chats', steps: Array.from({length: 13}, (_, i) => ({
    stepId: 'chat-' + i,
    originalRequestId: 'original-' + i,
    fingerprintSha256: sha,
    effect: i === 12 ? 'mutation' as const : 'read_only' as const,
    status: i < 3 ? 'completed' as const : 'pending' as const,
    ...(i < 3 ? {completionDigestSha256: sha} : {}),
  }))};
}
test('R13 preserves completed observations and batches pending reads', () => {
  const work = fixture();
  const before = JSON.stringify(work);
  const plan = planToolWorkflowContinuation(work, {maxCalls: 5, reserveCalls: 2});
  assert.equal(plan.status, 'READY');
  assert.deepEqual(plan.selected, ['chat-3', 'chat-4', 'chat-5']);
  assert.equal(plan.deferredReadOnly.length, 6);
  assert.deepEqual(plan.requireExternalAdmission, ['chat-12']);
  assert.deepEqual(plan.completed, ['chat-0', 'chat-1', 'chat-2']);
  assert.equal(JSON.stringify(work), before);
  assert.ok(plan.selected.length + plan.reservedCalls <= plan.maxCalls);
});
test('R13 budget exhaustion suspends without dropping any steps', () => {
  const plan = planToolWorkflowContinuation(fixture(), {maxCalls: 2, reserveCalls: 2});
  assert.equal(plan.status, 'CALL_BUDGET_EXHAUSTED');
  assert.deepEqual(plan.selected, []);
  assert.equal(plan.deferredReadOnly.length, 9);
  assert.equal(plan.completed.length, 3);
});
test('R13 upstream blocked and UNKNOWN mutations cannot enter a replay batch', () => {
  const work = fixture();
  const changed = {...work, steps: work.steps.map((step, i) =>
    ({...step, status: i === 3 ? 'blocked' as const
      : i === 4 ? 'unknown' as const : step.status}))};
  const plan = planToolWorkflowContinuation(changed, {maxCalls: 10});
  assert.deepEqual(plan.blocked, ['chat-3']);
  assert.deepEqual(plan.unresolved, ['chat-4']);
  assert.ok(!plan.selected.includes('chat-3'));
  assert.ok(!plan.selected.includes('chat-4'));
  assert.deepEqual(plan.requireExternalAdmission, ['chat-12']);
});
test('R13 malformed, duplicate or fabricated completion checkpoints fail closed', () => {
  const work = fixture();
  for (const value of [
    {...work, version: 2},
    {...work, steps: [...work.steps, work.steps[0]]},
    {...work, steps: [{...work.steps[0], fingerprintSha256: 'invalid'}]},
    {...work, steps: [{...work.steps[3], completionDigestSha256: sha}]},
    {...work, steps: [{...work.steps[0], completionDigestSha256: undefined}]},
  ]) {
    assert.throws(() => validateToolWorkflowCheckpoint(value as ToolWorkflowCheckpoint));
  }
  assert.throws(() => planToolWorkflowContinuation(work, {maxCalls: -1}), /TOOL_CALL_BUDGET_INVALID/);
  assert.throws(() => planToolWorkflowContinuation(work, {maxCalls: Number.NaN}), /TOOL_CALL_BUDGET_INVALID/);
});
test('R13 upstream call-cap observation is not a Nexowire quota/Agent error', () => {
  const observed = classifyClientToolInterruption({
    kind: 'call_budget_exhausted', delivery: 'unknown', readOnly: false,
    correlationId: 'r13-budget-session-1',
  });
  assert.equal(observed.code, 'UPSTREAM_TOOL_CALL_BUDGET_EXHAUSTED');
  assert.equal(observed.causeLayer, 'upstream_client');
  assert.equal(observed.dispatchState, 'unknown');
  assert.equal(observed.retrySafety, 'reconcile_first');
  assert.equal(observed.certainty, 'confirmed');
});
test('R13 client refusal cannot imply nondelivery or replay authority', () => {
  const uncertain = classifyClientToolInterruption({
    kind: 'tool_refusal_observed', delivery: 'unknown', readOnly: false,
  });
  assert.equal(uncertain.causeLayer, 'upstream_client');
  assert.equal(uncertain.dispatchState, 'unknown');
  assert.equal(uncertain.retrySafety, 'reconcile_first');
  const notDelivered = classifyClientToolInterruption({
    kind: 'tool_refusal_observed', delivery: 'confirmed_not_delivered', readOnly: false,
  });
  assert.equal(notDelivered.dispatchState, 'not_dispatched');
  assert.equal(notDelivered.retrySafety, 'manual_review');
  assert.throws(() => classifyClientToolInterruption({
    kind: 'not_a_type', delivery: 'unknown', readOnly: true,
  } as never), /CLIENT_TOOL_INTERRUPTION_KIND_INVALID/);
});
test('R13 forged MCP/Agent-origin codes do not claim an upstream client fact', () => {
  const source = classifyClientToolInterruption({
    kind: 'call_budget_exhausted', delivery: 'confirmed_delivered', readOnly: false,
  });
  assert.equal(source.dispatchState, 'dispatched');
  assert.equal(source.retrySafety, 'reconcile_first');
});
