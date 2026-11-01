import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyFailure } from '../../../src/protocol/error-contract-v2.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const docs = readFileSync(resolve(root, 'docs/MCP_SURFACE.md'), 'utf8');
const output = JSON.parse(readFileSync(resolve(root, 'src/mcp/v1-output-contract.json'), 'utf8'));

test('output documentation distinguishes native ok, MCP isError and Hub-object profiles', () => {
  const section = docs.split('## Interpreting outputs without inventing success')[1]?.split('\n## ')[0];
  assert.ok(section, 'Output interpretation section exists');
  for (const term of ['`structuredContent.ok === true`', '`structuredContent.ok === false`',
    '`isError`', '`structuredContent.error`', '`structuredContent.idempotency`',
    '`nexowire_surface_info.mcpSurfaceVersion`']) {
    assert.ok(section.includes(term), `Unclear documented outcome: ${term}`);
  }
  const native = output.contracts.machine_snapshot;
  const hub = output.contracts.nexowire_surface_info;
  assert.equal(native.profile, 'native-execution-v1');
  assert.equal(hub.profile, 'hub-object-v1');
  assert.ok(native.fields.some((field) => field.path === 'ok' && field.type === 'boolean'));
  assert.ok(!hub.fields.some((field) => field.path === 'ok'));
  assert.match(section, /not a guarantee/i);
});

test('unknown and timeout are reconciliation work, not successful completion', () => {
  for (const code of ['MUTATION_STATE_UNKNOWN', 'IDEMPOTENCY_STATE_UNKNOWN', 'AGENT_TIMEOUT']) {
    const event = classifyFailure({ code, observedAt: 'mcp_hub', dispatched: 'unknown', readOnly: false });
    assert.equal(event.retrySafety, 'reconcile_first');
    assert.equal(event.dispatchState, 'unknown');
    assert.doesNotMatch(event.nextAction, /safe to replay|automatically repeat/i);
  }
  const notDispatched = classifyFailure({
    code: 'TIMEOUT', observedAt: 'mcp_hub', dispatched: false, readOnly: false,
  });
  assert.equal(notDispatched.dispatchState, 'not_dispatched');

  const section = docs.split('## Interpreting outputs without inventing success')[1]?.split('\n## ')[0];
  assert.match(section, /cancellation, transport\s+timeout, lost response, or `UNKNOWN` status/);
  assert.match(section, /is \*\*not\*\*\s+an automatic `succeeded` or `failed` verdict/);
  assert.match(section, /`not_dispatched`/);
  assert.doesNotMatch(section, /cancellation guarantees no side effects/i);
});
