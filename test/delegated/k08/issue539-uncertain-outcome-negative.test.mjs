import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure } from '../../../src/protocol/error-contract-v2.ts';

// #539 R01/R18: synthetic, offline cases. No Hub/Agent, provider or mutations.
const cases = [
  {
    name: 'unknown delivery is not evidence of an absent mutation',
    evidence: { code: 'NETWORK_TIMEOUT', observedAt: 'mcp_hub', dispatched: 'unknown' },
    expected: { causeLayer: 'undetermined', certainty: 'unknown', dispatchState: 'unknown', retrySafety: 'reconcile_first' },
  },
  {
    name: 'confirmed authorization code cannot erase an already-dispatched effect',
    evidence: { code: 'MCP_TARGET_NOT_AUTHORIZED', observedAt: 'mcp_hub', dispatched: true },
    expected: { causeLayer: 'mcp_hub', certainty: 'confirmed', dispatchState: 'dispatched', retrySafety: 'reconcile_first' },
  },
  {
    name: 'an untrusted shell exit code does not prove a native-agent origin',
    evidence: { code: 'SHELL_EXIT_NONZERO', observedAt: 'mcp_hub', dispatched: 'unknown' },
    expected: { causeLayer: 'undetermined', certainty: 'unknown', retrySafety: 'reconcile_first' },
  },
  {
    name: 'the same shell exit code from a trusted agent can be attributed to an operation',
    evidence: { code: 'SHELL_EXIT_NONZERO', observedAt: 'native_agent', dispatched: false },
    expected: { causeLayer: 'operation', certainty: 'confirmed', dispatchState: 'not_dispatched', retrySafety: 'manual_review' },
  },
  {
    name: 'MCP-specific authorization strings from the upstream client do not establish MCP origin',
    evidence: { code: 'MCP_TARGET_NOT_AUTHORIZED', observedAt: 'upstream_client', dispatched: 'unknown' },
    expected: { causeLayer: 'undetermined', certainty: 'unknown', retrySafety: 'reconcile_first' },
  },
  {
    name: 'malformed public error codes do not become trusted provenance',
    evidence: { code: '<not-a-code>', observedAt: 'mcp_hub', dispatched: 'unknown' },
    expected: { code: 'UNCLASSIFIED_ERROR', certainty: 'unknown', retrySafety: 'reconcile_first' },
  },
];

for (const item of cases) {
  test(`Q-185 provenance negative: ${item.name}`, () => {
    const result = classifyFailure(item.evidence);
    for (const [key, value] of Object.entries(item.expected)) {
      assert.equal(result[key], value, `${item.evidence.code}: ${key}`);
    }
  });
}

test('Q-465 control: an observed identity-boundary auth denial can be attributed to identity', () => {
  const result = classifyFailure({ code: 'AUTH_REQUIRED', observedAt: 'identity', dispatched: false });
  assert.equal(result.causeLayer, 'identity');
  assert.equal(result.certainty, 'confirmed');
  assert.equal(result.dispatchState, 'not_dispatched');
  assert.equal(result.retrySafety, 'after_reauthorization');
});

test('Q-465 RED: an upstream-client AUTH_REQUIRED string alone cannot prove identity origin', () => {
  const result = classifyFailure({ code: 'AUTH_REQUIRED', observedAt: 'upstream_client', dispatched: 'unknown' });
  assert.equal(result.causeLayer, 'undetermined', 'An untrusted foreign code cannot establish identity source');
  assert.equal(result.certainty, 'unknown');
  assert.equal(result.dispatchState, 'unknown');
  assert.equal(result.retrySafety, 'reconcile_first');
});
