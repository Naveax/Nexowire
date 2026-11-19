import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

// Issue #539: offline-only UI redaction check. No credentials, Hub or real HTTP.
const CANARY = 'FAKE_CANARY_DENIED_BODY_DO_NOT_RENDER';
const sourcePath = fileURLToPath(new URL('../../../web/admin.js', import.meta.url));
const ids = ['users', 'users-detail', 'online-devices', 'devices-total', 'calls',
  'success-rate', 'owner-spend', 'capacity', 'admin-pill', 'admin-metrics',
  'admin-error', 'admin-error-message'];

async function inspect(source, status) {
  let bodyReads = 0;
  const calls = [];
  const nodes = new Map(ids.map((id) => {
    const classes = new Set(id === 'admin-error' ? ['hidden'] : []);
    const attributes = new Map();
    return [id, { textContent: '', className: '',
      classList: { add: (k) => classes.add(k), remove: (k) => classes.delete(k),
        contains: (k) => classes.has(k) },
      setAttribute: (k, v) => attributes.set(k, String(v)),
      getAttribute: (k) => attributes.get(k) ?? null,
    }];
  }));
  const response = { ok: false, status, statusText: CANARY,
    json: async () => { bodyReads++; return { token: CANARY }; },
    text: async () => { bodyReads++; return CANARY; },
  };
  await runInNewContext(source, {
    document: { getElementById: (id) => {
      if (!nodes.has(id)) throw new Error('Unknown DOM id: ' + id);
      return nodes.get(id);
    } },
    fetch: async (url, options) => { calls.push({ url, options }); return response; },
    Intl,
  }, { filename: 'web/admin.js', timeout: 1000 });
  const display = [...nodes.values()].map((n) => n.textContent + '|' + n.className).join('\n');
  const contract = calls.length === 1 && calls[0].url === '/api/v1/admin/overview' &&
    calls[0].options?.credentials === 'include' &&
    (calls[0].options?.method ?? 'GET') === 'GET';
  const noFalseSuccess = nodes.get('users').textContent === '—' &&
    nodes.get('calls').textContent === '—' &&
    !nodes.get('admin-error').classList.contains('hidden') &&
    nodes.get('admin-metrics').getAttribute('aria-busy') === 'false';
  const redacted = bodyReads === 0 && !display.includes(CANARY);
  const statusVisible = nodes.get('admin-error-message').textContent.includes(String(status));
  return { pass: contract && noFalseSuccess && redacted && statusVisible,
    contract, noFalseSuccess, redacted, statusVisible, bodyReads };
}

for (const status of [401, 403, 503]) {
  test('HTTP ' + status + ' body/statusText cannot reach rendered UI', async () => {
    const report = await inspect(readFileSync(sourcePath, 'utf8'), status);
    assert.equal(report.pass, true, JSON.stringify(report));
    assert.equal(report.bodyReads, 0);
  });
}

function badSource(errorExpression, options = "{ credentials: 'include' }") {
  return [
    'const $ = (id) => document.getElementById(id);',
    'async function load() {',
    "const response = await fetch('/api/v1/admin/overview', " + options + ');',
    "$('users').textContent = '—'; $('calls').textContent = '—';",
    "$('admin-error').classList.remove('hidden');",
    "$('admin-metrics').setAttribute('aria-busy', 'false');",
    "$('admin-error-message').textContent = " + errorExpression + ';',
    '}', 'load();',
  ].join('\n');
}

test('catches fake denied JSON-token exposure', async () => {
  const report = await inspect(badSource('(await response.json()).token'), 401);
  assert.equal(report.bodyReads, 1);
  assert.equal(report.redacted, false);
  assert.equal(report.pass, false);
});

test('catches fake denied statusText exposure', async () => {
  const report = await inspect(badSource('response.statusText'), 503);
  assert.equal(report.bodyReads, 0);
  assert.equal(report.redacted, false);
  assert.equal(report.pass, false);
});

test('refuses POST or omitted credentials despite a sanitized message', async () => {
  const report = await inspect(badSource("'HTTP ' + response.status", "{ method: 'POST' }"), 403);
  assert.equal(report.contract, false);
  assert.equal(report.pass, false);
});
