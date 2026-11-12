import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Dependency-free/source-only: no live Hub, Agent, provider, protected console or secrets.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const surface = read('docs/MCP_SURFACE.md');
const architecture = read('docs/ARCHITECTURE.md');
const attribution = read('src/protocol/error-contract-v2.ts');
const inputs = JSON.parse(read('src/mcp/v1-input-contract.json'));
const outputs = JSON.parse(read('src/mcp/v1-output-contract.json')).contracts;

function section(source, heading) {
  const start = source.indexOf(heading);
  assert.ok(start >= 0, `Missing heading: ${heading}`);
  const tail = source.slice(start + heading.length);
  const next = tail.search(/^## /m);
  return next < 0 ? tail : tail.slice(0, next);
}

const diagnostic = section(surface, '## Diagnosing an error without confusing its origin (#539 R01/R13/R18)');
const consoleSection = section(architecture, '### Local status versus effective authorization (#812)');

test('R01 distinguishes the observed layer, attributed cause, certainty, delivery and retry', () => {
  for (const field of ['observedAt', 'causeLayer', 'certainty', 'dispatchState', 'retrySafety']) {
    assert.match(attribution, new RegExp(`\\b${field}:`), `Source attribution missing ${field}`);
    assert.ok(diagnostic.includes('`' + field + '`'), `Documentation omits ${field}`);
  }
  assert.match(attribution, /causeLayer: FailureLayer = 'undetermined'/);
  assert.match(diagnostic, /familiar error \*string\* alone\s+does not prove/);
});

test('R13 upstream-client refusal is not silently rewritten as MCP authorization', () => {
  assert.match(attribution, /observedAt === 'upstream_client'/);
  assert.match(attribution, /code === 'UPSTREAM_TOOL_REFUSAL_OBSERVED'/);
  assert.match(attribution, /code === 'MCP_TARGET_NOT_AUTHORIZED'/);
  assert.match(attribution, /Do not reroute or encode the same call to evade a denial/);
  assert.match(diagnostic, /`UPSTREAM_TOOL_REFUSAL_OBSERVED`/);
  assert.match(diagnostic, /private policy reason is known/);
  assert.match(diagnostic, /`MCP_TARGET_NOT_AUTHORIZED`/);
  assert.match(diagnostic, /acceptable bypass/);
});

test('R18 progress, command exit and independent acceptance are separate', () => {
  assert.match(attribution, /code === 'SHELL_EXIT_NONZERO'/);
  assert.match(attribution, /code === 'TASK_VERIFICATION_FAILED'/);
  assert.match(diagnostic, /`SHELL_EXIT_NONZERO`/);
  assert.match(diagnostic, /`TASK_VERIFICATION_FAILED`/);
  assert.match(diagnostic, /Running \/ queued:[^\n]*not\*\* completed work/);
  assert.match(diagnostic, /Outcome unknown:[^\n]*missing/);
  assert.match(diagnostic, /independently verified requested postcondition/);
  assert.doesNotMatch(diagnostic, /running PID proves business-task completion/i);
});

test('main MCP v1 schema is a ground truth for referenced status tool', () => {
  const name = 'agent_operation_status';
  assert.ok(surface.includes('`' + name + '`'));
  assert.ok(inputs[name] && outputs[name]);
  assert.deepEqual(inputs[name].required, ['request_id']);
  assert.equal(inputs[name].properties.request_id.format, 'uuid');
  assert.equal(outputs[name].tool, name);
  assert.equal(outputs[name].profile, 'native-execution-v1');
  assert.match(diagnostic, /`request_id` UUID/);
  const corrupted = { ...inputs[name], required: ['operation_name'] };
  assert.notDeepEqual(corrupted.required, ['request_id'], 'Schema drift is observable');
});

test('#812 local console status must not be presented as proof of effective grant', () => {
  const source = read('src/agent/windows-console-grant.ts');
  const policy = read('docs/AI_PHYSICAL_CONSOLE_FULL_ACCESS_GATE.md');
  assert.match(source, /active:timed\.active \|\| core\.active/);
  assert.match(source, /Never synthesize an owner grant from API access alone/);
  assert.match(policy, /FULL uzaktan API izni, fiziksel/);
  assert.match(consoleSection, /`status\.active:false`/);
  assert.match(consoleSection, /installed binary provenance/);
  assert.match(consoleSection, /not permission to remove the local consent gate/);
});

test('negative: removing source-of-truth and no-replay warnings fails our acceptance', () => {
  function checkCopy(copy) {
    assert.match(copy, /missing operation record is \*\*not\*\* proof of no effect/);
    assert.match(copy, /Do not\s+invent an operation ID or auto-replay after a timeout/);
  }
  checkCopy(diagnostic);
  assert.throws(() => checkCopy(diagnostic.replace('**not** proof', 'proof')));
  assert.throws(() => checkCopy(diagnostic.replace('auto-replay after a timeout', 'immediately retry')));
});
