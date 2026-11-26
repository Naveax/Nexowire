import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure } from '../../../src/protocol/error-contract-v2.ts';

// W-707 / #539 R01: synthetic evidence of the HTTP Hub's own 403 code.
// src/mcp/http.ts emits MCP_TOOL_NOT_AUTHORIZED before metering or dispatch.
// No HTTP call, real account, or authorization change is performed.
const cases = [
  ['Hub HTTP 403 has a confirmed local denial origin',
    { code: 'MCP_TOOL_NOT_AUTHORIZED', observedAt: 'mcp_hub', dispatched: false },
    ['mcp_hub', 'confirmed', 'not_dispatched', 'after_reauthorization']],
  ['existing target-denial mapping remains intact',
    { code: 'MCP_TARGET_NOT_AUTHORIZED', observedAt: 'mcp_hub', dispatched: false },
    ['mcp_hub', 'confirmed', 'not_dispatched', 'after_reauthorization']],
  ['foreign denial string cannot prove Hub provenance',
    { code: 'MCP_TOOL_NOT_AUTHORIZED', observedAt: 'upstream_client', dispatched: 'unknown' },
    ['undetermined', 'unknown', 'unknown', 'reconcile_first']],
  ['unavailable transport does not prove an authorization denial',
    { code: 'UNAVAILABLE', observedAt: 'mcp_hub', dispatched: 'unknown' },
    ['undetermined', 'unknown', 'unknown', 'reconcile_first']],
];
for (const [name, evidence, expected] of cases) {
  test(name, () => {
    const result = classifyFailure(evidence);
    assert.deepEqual([result.causeLayer, result.certainty, result.dispatchState, result.retrySafety], expected);
  });
}
