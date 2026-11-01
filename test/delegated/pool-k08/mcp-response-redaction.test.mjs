import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  redactDiagnosticText,
  redactDiagnosticValue,
} from '../../../src/protocol/error-contract-v2.ts';

// All identifiers are synthetic. No Hub/Agent, account, network or real secret.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = readFileSync(resolve(root, 'src/mcp/create-server.ts'), 'utf8');
const fake = 'ghp_FAKE_TEST_ONLY_0123456789abcdef';
const secret = 'FAKE_TEST_ONLY';

function safeChannels(result) {
  const structured = redactDiagnosticValue(result);
  return {
    structuredContent: structured,
    text: JSON.stringify(structured),
  };
}

function assertAbsent(value) {
  assert.doesNotMatch(JSON.stringify(value), new RegExp(secret));
}

test('toolResult source redacts before constructing both MCP response channels', () => {
  const toolResult = source.split('function toolResult(data: unknown, isError = false) {')[1]
    ?.split('async function allRoutingEntries(')[0];
  assert.ok(toolResult, 'Hub MCP result helper is present');
  assert.match(toolResult, /const safeData = redactDiagnosticValue\(data\)/);
  assert.match(toolResult, /structuredContent: structured/);
  assert.match(toolResult, /JSON\.stringify\(safeData, null, 2\)/);
});

test('nested error output hides synthetic tokens from both structured and JSON text', () => {
  const original = {
    ok: false,
    operationId: 'synthetic-1',
    error: {
      code: 'SYNTHETIC_ERROR',
      message: `Bearer ${fake}; token=${fake}`,
      attribution: { nextAction: `Visit https://test.invalid/help?access_token=${fake}` },
    },
    meta: { authorization: `Bearer ${fake}`, client_secret: fake },
  };
  assert.match(JSON.stringify(original), new RegExp(secret), 'Fixture must contain a fake secret');
  const both = safeChannels(original);
  assertAbsent(both.structuredContent);
  assertAbsent(both.text);
  assert.equal(both.structuredContent.error.code, 'SYNTHETIC_ERROR');
  assert.equal(both.structuredContent.operationId, 'synthetic-1');
});

test('successful sample output with a nested array and sensitive keys remains parseable', () => {
  const payload = {
    ok: true,
    data: {
      rows: [
        { label: 'item 1', api_key: fake },
        { label: 'item 2', headers: { Authorization: `Bearer ${fake}` } },
      ],
    },
  };
  const { structuredContent, text } = safeChannels(payload);
  assertAbsent(structuredContent);
  assertAbsent(text);
  assert.equal(structuredContent.ok, true);
  assert.deepEqual(JSON.parse(text), structuredContent);
  assert.equal(structuredContent.data.rows[0].label, 'item 1');
});

test('private key and query strings are masked, with no real credentials involved', () => {
  const value = [
    '-----BEGIN PRIVATE KEY-----',
    fake,
    '-----END PRIVATE KEY-----',
    `https://test.invalid/path?api_key=${fake}&token=${fake}`,
  ].join('\n');
  const redacted = redactDiagnosticText(value);
  assert.doesNotMatch(redacted, new RegExp(secret));
  assert.match(redacted, /REDACTED PRIVATE KEY/);
  assert.match(redacted, /api_key=\[REDACTED\]/);
  assert.match(redacted, /token=\[REDACTED\]/);
});

test('circular diagnostic and repeated references do not crash or leak payloads', () => {
  const shared = { token: fake, harmless: 'keep-me' };
  const input = { first: shared, second: shared };
  input.self = input;
  const result = redactDiagnosticValue(input);
  assertAbsent(result);
  assert.equal(result.first.harmless, 'keep-me');
  assert.equal(result.second.harmless, 'keep-me');
  assert.equal(result.self, '[REDACTED UNINSPECTABLE DATA]');
});

test.todo('Assess Cookie/Set-Cookie header handling at the security-owned diagnostic boundary');
