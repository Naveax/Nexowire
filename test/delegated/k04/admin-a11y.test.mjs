import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../../../web/admin.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../../../web/admin.js', import.meta.url), 'utf8');

const ids = [
  'admin-pill', 'admin-metrics', 'admin-error', 'admin-error-message',
  'users', 'users-detail', 'online-devices', 'devices-total',
  'calls', 'success-rate', 'owner-spend', 'capacity',
];

const validOverview = () => ({
  users: { total: 12, active24h: 4, paid: 1 },
  devices: { online: 3, total: 6 },
  usage: { calls24h: 42, successRate: null },
  infrastructure: {
    ownerPaidSpendAllowed: false,
    providerAutoUpgradeAllowed: false,
    freeCapacityPercent: null,
  },
});

async function renderWithFetch(fetchResult) {
  const responses = Array.isArray(fetchResult) ? fetchResult : [fetchResult];
  let responseIndex = 0;
  const nodes = new Map(ids.map((id) => {
    const classes = new Set();
    const attributes = new Map();
    return [id, {
      textContent: '',
      className: '',
      classes,
      attributes,
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
      },
      setAttribute: (name, value) => attributes.set(name, value),
    }];
  }));
  const calls = [];
  const context = {
    document: { getElementById: (id) => nodes.get(id) },
    fetch: async (url, options) => {
      calls.push({ url, options });
      const response = responses[responseIndex++];
      if (response instanceof Error) throw response;
      return response;
    },
    Intl,
  };

  // The last expression in admin.js is load(), so the VM returns its promise.
  await runInNewContext(script, context, { filename: 'admin.js', timeout: 1000 });
  return { nodes, calls, reload: () => runInNewContext('load()', context, { timeout: 1000 }) };
}

test('T-019: every KPI is a named article with a visible heading and stable value ids', () => {
  assert.match(html, /<main class="shell">/);
  assert.match(html, /<section id="admin-metrics"[^>]*aria-label="Yönetim metrikleri"/);
  const cards = [...html.matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article>/g)];
  assert.equal(cards.length, 4);
  const values = ['users', 'online-devices', 'calls', 'owner-spend'];
  for (const [index, [, attributes, body]] of cards.entries()) {
    const label = attributes.match(/aria-labelledby="([^"]+)"/)?.[1];
    assert.ok(label, `metric ${index} must have an accessible label`);
    assert.match(body, new RegExp(`<h2 id="${label}" class="label">[^<]+<\\/h2>`));
    assert.match(body, new RegExp(`<strong id="${values[index]}">—<\\/strong>`));
  }
  // This dashboard is a card summary, not a data table: no table headers to audit.
  assert.doesNotMatch(html, /<table\b/i);
});

test('T-020/T-022: loading, error and status announcements have distinct semantics', () => {
  assert.match(html, /id="admin-pill"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(html, /id="admin-metrics"[^>]*aria-busy="true"/);
  assert.match(html, /id="admin-error"[^>]*hidden"[^>]*role="alert"[^>]*aria-labelledby="admin-error-title"[^>]*aria-describedby="admin-error-message"/);
  assert.match(html, /id="admin-error-title">Admin verisi alınamadı\.<\/strong>/);
});

test('T-021: scoped admin layout handles narrow screens and long metric strings', () => {
  assert.match(html, /\.admin-metrics\s*\{\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(html, /\.admin-metric strong\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(html, /\.admin-metric small\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(html, /@media \(max-width:\s*620px\)\s*\{\s*\.admin-metrics\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
});

test('T-020/T-022: success populates KPI values and releases busy state', async () => {
  const { nodes, calls } = await renderWithFetch({
    ok: true,
    json: async () => validOverview(),
  });
  assert.equal(nodes.get('users').textContent, '12');
  assert.equal(nodes.get('online-devices').textContent, '3');
  assert.equal(nodes.get('calls').textContent, '42');
  assert.equal(nodes.get('success-rate').textContent, 'Başarı oranı yok');
  assert.equal(nodes.get('capacity').textContent, 'Free kapasite verisi yok');
  assert.equal(nodes.get('admin-pill').textContent, 'Zero-spend aktif');
  assert.equal(nodes.get('admin-pill').className, 'pill admin-status good');
  assert.equal(nodes.get('admin-metrics').attributes.get('aria-busy'), 'false');
  assert.equal(nodes.get('admin-error').classes.has('hidden'), true);

  // T-023 negative: the presentation change must not add auth or mutation calls.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/admin/overview');
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(calls[0].options.method ?? 'GET', 'GET');
});

test('T-020/T-022: request failure exposes alert and clears busy state', async () => {
  const { nodes, calls } = await renderWithFetch({ ok: false, status: 503 });
  assert.equal(nodes.get('admin-pill').textContent, 'Offline');
  assert.equal(nodes.get('admin-pill').className, 'pill admin-status bad');
  assert.match(nodes.get('admin-error-message').textContent, /HTTP 503/);
  assert.equal(nodes.get('admin-error').classes.has('hidden'), false);
  assert.equal(nodes.get('admin-metrics').attributes.get('aria-busy'), 'false');
  assert.equal(nodes.get('users').textContent, '—');
  assert.equal(calls.length, 1);
});

test('T-020: rejected fetch remains an error, not a false populated dashboard', async () => {
  const { nodes } = await renderWithFetch(new Error('network unavailable'));
  assert.equal(nodes.get('admin-pill').textContent, 'Offline');
  assert.equal(nodes.get('admin-error').classes.has('hidden'), false);
  assert.equal(nodes.get('users').textContent, '—');
  assert.equal(nodes.get('admin-metrics').attributes.get('aria-busy'), 'false');
});

test('T-154: hidden admin error has an alert role; no silent-error-panel pattern remains', () => {
  assert.match(html, /id="admin-error"[^>]*class="[^"]*hidden"[^>]*role="alert"/);
  assert.match(script, /\$\('admin-error'\)\.classList\.remove\('hidden'\)/);
});

test('T-155: a failed repeat load clears stale success values and opens the error panel', async () => {
  const { nodes, reload, calls } = await renderWithFetch([
    { ok: true, json: async () => validOverview() },
    { ok: false, status: 503 },
  ]);
  assert.equal(nodes.get('users').textContent, '12');
  await reload();
  assert.equal(nodes.get('users').textContent, '—');
  assert.equal(nodes.get('calls').textContent, '—');
  assert.equal(nodes.get('admin-pill').className, 'pill admin-status bad');
  assert.equal(nodes.get('admin-error').classes.has('hidden'), false);
  assert.equal(nodes.get('admin-metrics').attributes.get('aria-busy'), 'false');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, '/api/v1/admin/overview');
    assert.equal(call.options.credentials, 'include');
    assert.equal(call.options.method ?? 'GET', 'GET');
  }
});

test('T-155: a successful repeat load hides a previously visible error', async () => {
  const { nodes, reload } = await renderWithFetch([
    { ok: false, status: 503 },
    { ok: true, json: async () => validOverview() },
  ]);
  assert.equal(nodes.get('admin-error').classes.has('hidden'), false);
  await reload();
  assert.equal(nodes.get('admin-error').classes.has('hidden'), true);
  assert.equal(nodes.get('admin-error-message').textContent, '');
  assert.equal(nodes.get('users').textContent, '12');
  assert.equal(nodes.get('admin-pill').className, 'pill admin-status good');
});

test('T-155: while repeat loading is pending, stale counters are hidden and busy is true', async () => {
  let finishRequest;
  const pending = new Promise((resolve) => { finishRequest = resolve; });
  const { nodes, reload } = await renderWithFetch([
    { ok: true, json: async () => validOverview() },
    pending,
  ]);
  const loading = reload();
  assert.equal(nodes.get('users').textContent, '—');
  assert.equal(nodes.get('admin-pill').textContent, 'Yükleniyor');
  assert.equal(nodes.get('admin-metrics').attributes.get('aria-busy'), 'true');
  assert.equal(nodes.get('admin-error').classes.has('hidden'), true);
  finishRequest({ ok: true, json: async () => validOverview() });
  await loading;
  assert.equal(nodes.get('users').textContent, '12');
  assert.equal(nodes.get('admin-metrics').attributes.get('aria-busy'), 'false');
});

test('T-156: card-only admin overview does not invent table headers or status cells', () => {
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)];
  assert.equal(tables.length, 0, 'the current admin overview has no actual data table');
  assert.equal([...html.matchAll(/<article\b[^>]*aria-labelledby=/g)].length, 4);
  // If a table is introduced, this task must be revisited with actual <th scope> headers.
});

test('T-157: empty, malformed and nonsensical 200 JSON never populate success metrics', async () => {
  const invalid = [
    null,
    {},
    { ...validOverview(), users: { ...validOverview().users, total: -1 } },
    { ...validOverview(), users: { ...validOverview().users, total: Number.NaN } },
    { ...validOverview(), devices: { ...validOverview().devices, online: 99 } },
    { ...validOverview(), usage: { ...validOverview().usage, successRate: Infinity } },
    { ...validOverview(), infrastructure: { ...validOverview().infrastructure, ownerPaidSpendAllowed: undefined } },
  ];
  for (const sample of invalid) {
    const { nodes } = await renderWithFetch({ ok: true, json: async () => sample });
    assert.equal(nodes.get('users').textContent, '—', JSON.stringify(sample));
    assert.equal(nodes.get('owner-spend').textContent, '—');
    assert.equal(nodes.get('admin-pill').className, 'pill admin-status bad');
    assert.equal(nodes.get('admin-error').classes.has('hidden'), false);
    assert.equal(nodes.get('admin-metrics').attributes.get('aria-busy'), 'false');
    assert.match(nodes.get('admin-error-message').textContent, /Yönetim özeti eksik veya geçersiz/);
  }
});

test('T-157: zero remains a valid number, while a real policy warning remains visible', async () => {
  const zero = validOverview();
  zero.users = { total: 0, active24h: 0, paid: 0 };
  zero.devices = { total: 0, online: 0 };
  zero.usage = { calls24h: 0, successRate: 0 };
  zero.infrastructure.freeCapacityPercent = 0;
  zero.infrastructure.ownerPaidSpendAllowed = true;
  const { nodes } = await renderWithFetch({ ok: true, json: async () => zero });
  assert.equal(nodes.get('users').textContent, '0');
  assert.equal(nodes.get('calls').textContent, '0');
  assert.equal(nodes.get('success-rate').textContent, '0.00% başarı');
  assert.equal(nodes.get('capacity').textContent, 'Free kapasite %0');
  assert.equal(nodes.get('owner-spend').textContent, 'UYARI');
  assert.equal(nodes.get('admin-pill').className, 'pill admin-status bad');
});
