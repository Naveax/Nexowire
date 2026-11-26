import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyFailure, classifyUndeliveredUpstreamRefusal } from '../../../src/protocol/error-contract-v2.ts';

// Executes real v2 attribution and reads frozen MCP contracts. Does NOT call
// Hub, Agent, auth, a provider, Windows console controls or a live mutation.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const surface = read('docs/MCP_SURFACE.md');
const architecture = read('docs/ARCHITECTURE.md');
const inputs = JSON.parse(read('src/mcp/v1-input-contract.json'));
const outputs = JSON.parse(read('src/mcp/v1-output-contract.json')).contracts;
const agentJournal = read('src/agent/operation-journal.ts');
const agentExecutor = read('src/agent/executors.ts');
const consoleGrant = read('src/agent/windows-console-grant.ts');

function checkMatrix(rows) {
  for (const item of rows) {
    const observed = classifyFailure(item.evidence);
    for (const [field, expected] of Object.entries(item.expected)) {
      assert.equal(observed[field], expected, `${item.evidence.code} ${field}`);
    }
    assert.ok(surface.includes('`' + item.evidence.code + '`'),
      `Missing source-backed user explanation for ${item.evidence.code}`);
  }
}

const cases = [
  {
    evidence: { code: 'UPSTREAM_TOOL_REFUSAL_OBSERVED', observedAt: 'upstream_client', dispatched: false },
    expected: { causeLayer: 'upstream_client', certainty: 'confirmed', dispatchState: 'not_dispatched', retrySafety: 'manual_review' },
  },
  {
    evidence: { code: 'AGENT_OFFLINE', observedAt: 'device_connection', dispatched: 'unknown' },
    expected: { causeLayer: 'device_connection', certainty: 'confirmed', dispatchState: 'unknown', retrySafety: 'reconcile_first' },
  },
  {
    evidence: { code: 'MCP_TARGET_NOT_AUTHORIZED', observedAt: 'mcp_hub', dispatched: false },
    expected: { causeLayer: 'mcp_hub', certainty: 'confirmed', dispatchState: 'not_dispatched', retrySafety: 'after_reauthorization' },
  },
  {
    evidence: { code: 'PATH_DENIED', observedAt: 'native_agent', dispatched: false },
    expected: { causeLayer: 'native_agent', certainty: 'confirmed', dispatchState: 'not_dispatched', retrySafety: 'after_reauthorization' },
  },
  {
    evidence: { code: 'MUTATION_STATE_UNKNOWN', observedAt: 'mcp_hub', dispatched: 'unknown' },
    expected: { causeLayer: 'undetermined', certainty: 'unknown', dispatchState: 'unknown', retrySafety: 'reconcile_first' },
  },
];

test('T-438 #539 R01: real classifier keeps five independent origin/retry combinations', () => {
  checkMatrix(cases);
  for (const item of cases) {
    assert.match(surface, new RegExp('`' + item.expected.causeLayer + '`'),
      `Documentation should name evidence origin ${item.expected.causeLayer}`);
    assert.match(surface, new RegExp('`' + item.expected.retrySafety + '`'),
      `Documentation should name retry classification ${item.expected.retrySafety}`);
  }
});

test('T-438 negative: untrusted emitter string does not establish cause or no-dispatch', () => {
  const disguised = classifyFailure({
    code: 'MCP_TARGET_NOT_AUTHORIZED', observedAt: 'native_agent', dispatched: 'unknown',
  });
  assert.equal(disguised.causeLayer, 'undetermined');
  assert.equal(disguised.dispatchState, 'unknown');
  assert.equal(disguised.retrySafety, 'reconcile_first');
  const disconnectedMutation = classifyFailure({
    code: 'AGENT_OFFLINE', observedAt: 'device_connection', dispatched: true,
  });
  assert.equal(disconnectedMutation.retrySafety, 'reconcile_first');
  assert.equal(disconnectedMutation.dispatchState, 'dispatched');
  assert.throws(() => checkMatrix([{
    evidence: cases[1].evidence,
    expected: { retrySafety: 'after_reauthorization' },
  }]));
});

function statusEvidenceLabel(result, independentlyVerified = false) {
  if (result?.ok !== true || result?.data?.found !== true) return 'UNCONFIRMED';
  const record = result.data.record;
  if (!record || ['unknown', 'in_progress'].includes(record.status)) return 'UNCONFIRMED';
  if (record.status === 'failed') return 'FAILED';
  return record.status === 'succeeded' && independentlyVerified === true
    ? 'VERIFIED_TASK_RESULT' : 'UNCONFIRMED';
}

test('T-439 #539 R18: successful read-only status query cannot upgrade UNKNOWN to success', () => {
  assert.match(agentExecutor, /case 'agent\.operation\.status'/);
  assert.match(agentExecutor, /return \{data:\{found:record!==undefined/);
  assert.match(agentJournal, /status:z\.enum\(\['in_progress','succeeded','failed','unknown'\]\)/);
  for (const result of [
    { ok: true, data: { found: false } },
    { ok: true, data: { found: true, record: { status: 'unknown' } } },
    { ok: true, data: { found: true, record: { status: 'in_progress' } } },
    { ok: true, data: { found: true, record: { status: 'succeeded' } } },
  ]) assert.equal(statusEvidenceLabel(result), 'UNCONFIRMED');
  assert.equal(statusEvidenceLabel({ ok: true, data: { found: true, record: { status: 'failed' } } }), 'FAILED');
  assert.equal(statusEvidenceLabel({ ok: true, data: { found: true, record: { status: 'succeeded' } } }, true), 'VERIFIED_TASK_RESULT');
  assert.match(surface, /successful status query is not successful mutation/i);
  assert.match(surface, /`record\.status` is `in_progress` or `unknown`/);
  assert.match(surface, /broader `audit_query` filter's/);
});

test('T-440 #812: remote status observation remains separate from actual local permission', () => {
  assert.match(consoleGrant, /active:timed\.active \|\| core\.active/);
  assert.match(consoleGrant, /Never synthesize an owner grant from API access alone/);
  assert.match(architecture, /reported console status/i);
  assert.match(architecture, /effective authorization at the individual/);
  assert.match(architecture, /observed input effect/i);
  assert.match(architecture, /stored FULL\s+preference nor a successful MCP status query supplies missing local consent/i);
  const changed = architecture.replace('supplies missing local consent', 'supplies full local consent');
  assert.doesNotMatch(changed, /supplies missing local consent/i);
});

test('T-441 #539 R13: provider refusal never becomes an alternate-tool bypass suggestion', () => {
  const observed = classifyFailure(cases[0].evidence);
  const undelivered = classifyUndeliveredUpstreamRefusal('synthetic-correlation');
  assert.match(observed.nextAction, /Do not reroute or encode the same call to evade a denial/);
  assert.equal(undelivered.dispatchState, 'not_dispatched');
  assert.equal(undelivered.causeLayer, 'upstream_client');
  const spoofed = classifyFailure({
    code: 'UPSTREAM_TOOL_REFUSAL_OBSERVED', observedAt: 'mcp_hub', dispatched: 'unknown',
  });
  assert.equal(spoofed.causeLayer, 'undetermined');
  assert.equal(spoofed.retrySafety, 'reconcile_first');
  assert.match(surface, /never route around it/i);
  assert.match(surface, /Hub cannot infer an unseen provider refusal/i);
});

function validateContract(input, output) {
  assert.deepEqual(Object.keys(input).sort(), Object.keys(output).sort(), 'MCP tool name drift');
  assert.deepEqual(input.agent_operation_status.required, ['request_id']);
  assert.equal(input.agent_operation_status.properties.request_id.format, 'uuid');
  assert.equal(output.agent_operation_status.profile, 'native-execution-v1');
  assert.ok(output.agent_operation_status.fields.some((field) => field.path === 'ok' && field.type === 'boolean'));
}

test('T-442 #539: 110 current frozen MCP tool inputs/outputs still match docs and negative drift fails', () => {
  assert.equal(Object.keys(inputs).length, 110);
  validateContract(inputs, outputs);
  assert.match(surface, /`request_id` UUID/);
  assert.match(surface, /`agent_operation_status`/);
  const removedInput = { ...inputs }; delete removedInput.agent_operation_status;
  assert.throws(() => validateContract(removedInput, outputs));
  const narrowed = { ...inputs, agent_operation_status: { ...inputs.agent_operation_status, required: ['device_id','request_id'] } };
  assert.throws(() => validateContract(narrowed, outputs));
  const wrongProfile = { ...outputs, agent_operation_status: { ...outputs.agent_operation_status, profile: 'hub-object-v1' } };
  assert.throws(() => validateContract(inputs, wrongProfile));
});
