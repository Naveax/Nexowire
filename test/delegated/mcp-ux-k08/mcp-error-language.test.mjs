import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyFailure,
  redactDiagnosticText,
  redactDiagnosticValue,
} from '../../../src/protocol/error-contract-v2.ts';

// Static QA only. Do not start an MCP listener, authenticate, or contact a device.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const httpSource = readFileSync(resolve(root, 'src/mcp/http.ts'), 'utf8');

function responseBodies(source, status) {
  const pattern = new RegExp(`res\\.status\\(${status}\\)\\.json\\(\\{([\\s\\S]*?)\\}\\);`, 'g');
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function assertResponse(source, status, code, fields) {
  const blocks = responseBodies(source, status);
  const block = blocks.find((text) => text.includes(`code: '${code}'`));
  assert.ok(block, `HTTP ${status} must include ${code}`);
  for (const [key, value] of Object.entries(fields)) {
    assert.match(block, new RegExp(`${key}: '${value}'`), `${code}: ${key}`);
  }
}

test('401 token expiry and 503 verifier outage offer DIFFERENT actions', () => {
  assertResponse(httpSource, 401, 'MCP_AUTH_REQUIRED', {
    error: 'unauthorized', layer: 'token', next_action: 'reauthorize',
  });
  assertResponse(httpSource, 503, 'MCP_AUTH_VERIFIER_UNAVAILABLE', {
    error: 'service_unavailable', layer: 'verification', next_action: 'retry_later',
  });
  const unsafeFixture = httpSource.replace(
    /code: 'MCP_AUTH_VERIFIER_UNAVAILABLE',\s*layer: 'verification',\s*next_action: 'retry_later'/,
    "code: 'MCP_AUTH_VERIFIER_UNAVAILABLE', layer: 'verification', next_action: 'reauthorize'",
  );
  assert.throws(() => assertResponse(unsafeFixture, 503, 'MCP_AUTH_VERIFIER_UNAVAILABLE', {
    next_action: 'retry_later',
  }));
});

test('403 forbidden MCP tool does not present a reconnection or retry action', () => {
  assertResponse(httpSource, 403, 'MCP_TOOL_NOT_AUTHORIZED', { error: 'forbidden' });
  const denied = responseBodies(httpSource, 403)
    .find((block) => block.includes("code: 'MCP_TOOL_NOT_AUTHORIZED'"));
  assert.doesNotMatch(denied, /next_action: '(?:reauthorize|retry_later)'/);
});

test('unknown mutation guidance requires reconciliation, never blind replay', () => {
  for (const code of ['MUTATION_STATE_UNKNOWN', 'IDEMPOTENCY_STATE_UNKNOWN']) {
    const outcome = classifyFailure({ code, observedAt: 'mcp_hub', dispatched: 'unknown' });
    assert.equal(outcome.dispatchState, 'unknown');
    assert.equal(outcome.retrySafety, 'reconcile_first');
    assert.match(outcome.nextAction, /original operation ID/i);
    assert.match(outcome.nextAction, /never blindly replay/i);
  }
});

test('connection and permission errors give scope-safe actions without invented root cause', () => {
  const disconnected = classifyFailure({
    code: 'AGENT_OFFLINE', observedAt: 'device_connection', dispatched: 'unknown',
  });
  assert.equal(disconnected.causeLayer, 'device_connection');
  assert.match(disconnected.nextAction, /connectivity/i);
  assert.match(disconnected.nextAction, /reconcile/i);

  const denied = classifyFailure({
    code: 'MCP_TARGET_NOT_AUTHORIZED', observedAt: 'mcp_hub', dispatched: false,
  });
  assert.equal(denied.retrySafety, 'after_reauthorization');
  assert.match(denied.nextAction, /authorized device|scoped MCP permission/i);

  const pathDenied = classifyFailure({
    code: 'PATH_DENIED', observedAt: 'native_agent', dispatched: false,
  });
  assert.match(pathDenied.nextAction, /do not switch to shell to bypass/i);

  const undetermined = classifyFailure({
    code: 'UNRECOGNIZED_FAILURE', observedAt: 'mcp_hub', dispatched: 'unknown',
  });
  assert.equal(undetermined.causeLayer, 'undetermined');
  assert.equal(undetermined.certainty, 'unknown');
  assert.equal(undetermined.retrySafety, 'reconcile_first');
});

test('diagnostic hints and nested payloads do not echo supplied fake secrets', () => {
  const fake = 'ghp_FAKEONLY1234567890abcdef';
  const phrase = `token=${fake}`;
  assert.doesNotMatch(redactDiagnosticText(phrase), /FAKEONLY/);
  const value = redactDiagnosticValue({
    token: fake,
    headers: { authorization: `Bearer ${fake}` },
    error: { message: phrase },
  });
  assert.doesNotMatch(JSON.stringify(value), /FAKEONLY/);
});
