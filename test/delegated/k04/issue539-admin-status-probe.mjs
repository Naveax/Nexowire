#!/usr/bin/env node
// Offline source-level probe for issue #539 R11/R18 admin display contracts.
// This does not perform a real HTTP request or modify authorization behavior.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const validOverview = () => ({
  users: { total: 3, active24h: 1, paid: 0 },
  devices: { total: 2, online: 1 },
  usage: { calls24h: 4, successRate: null },
  infrastructure: {
    ownerPaidSpendAllowed: false,
    providerAutoUpgradeAllowed: false,
    freeCapacityPercent: null,
  },
});

function createUi() {
  const ids = [
    'admin-pill', 'admin-metrics', 'admin-error', 'admin-error-message',
    'users', 'users-detail', 'online-devices', 'devices-total',
    'calls', 'success-rate', 'owner-spend', 'capacity',
  ];
  return new Map(ids.map((id) => {
    const classes = new Set(id === 'admin-error' ? ['hidden'] : []);
    const attrs = new Map();
    return [id, {
      textContent: id === 'admin-pill' ? 'Yükleniyor' : '—',
      className: '',
      classes,
      attrs,
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
      },
      setAttribute: (name, value) => attrs.set(name, value),
    }];
  }));
}

export async function renderAdminSource(source, response) {
  const nodes = createUi();
  const calls = [];
  const context = {
    document: { getElementById: (id) => nodes.get(id) },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return response;
    },
    Intl,
  };
  // Last expression in both the current main and owner #1068 is load().
  await runInNewContext(source, context, { filename: 'web/admin.js', timeout: 1000 });
  const pick = (id) => nodes.get(id);
  return {
    pill: pick('admin-pill').textContent,
    errorVisible: !pick('admin-error').classes.has('hidden'),
    message: pick('admin-error-message').textContent,
    users: pick('users').textContent,
    calls24h: pick('calls').textContent,
    busy: pick('admin-metrics').attrs.get('aria-busy') ?? null,
    requests: calls,
  };
}

export function assessCase(key, observed) {
  const readOnly = observed.requests.length === 1 &&
    observed.requests[0].url === '/api/v1/admin/overview' &&
    observed.requests[0].options.credentials === 'include' &&
    (observed.requests[0].options.method ?? 'GET') === 'GET';
  const noSuccess = observed.pill !== 'Zero-spend aktif' &&
    observed.users === '—' && observed.calls24h === '—';
  let pass = false;
  switch (key) {
    case 'valid':
      pass = observed.pill === 'Zero-spend aktif' && observed.users === '3';
      break;
    case 'invalid-negative':
    case 'invalid-missing':
      pass = noSuccess && observed.errorVisible;
      break;
    case 'http-401':
    case 'http-403':
      // A denied request is not a network-offline diagnosis.
      pass = noSuccess && observed.errorVisible && observed.pill !== 'Offline';
      break;
    case 'http-503':
      pass = noSuccess && observed.errorVisible;
      break;
  }
  return { key, pass: Boolean(pass && readOnly), observed: {
    pill: observed.pill,
    users: observed.users,
    calls24h: observed.calls24h,
    errorVisible: observed.errorVisible,
    busy: observed.busy,
  } };
}

export async function auditAdminSource(source) {
  const negative = validOverview();
  negative.users.total = -1;
  const cases = [
    ['valid', { ok: true, json: async () => validOverview() }],
    ['invalid-negative', { ok: true, json: async () => negative }],
    ['invalid-missing', { ok: true, json: async () => ({}) }],
    ['http-401', { ok: false, status: 401 }],
    ['http-403', { ok: false, status: 403 }],
    ['http-503', { ok: false, status: 503 }],
  ];
  const results = [];
  for (const [key, response] of cases) {
    results.push(assessCase(key, await renderAdminSource(source, response)));
  }
  return { passed: results.filter(({ pass }) => pass).length, total: results.length, results };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourcePath = process.argv[2];
  if (!sourcePath) {
    console.error('NOT_RUN: provide a checked-out admin.js source path');
    process.exitCode = 2;
  } else {
    try {
      const report = await auditAdminSource(readFileSync(resolve(sourcePath), 'utf8'));
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.passed === report.total ? 0 : 1;
    } catch (error) {
      console.error('PROBE FAILED:', error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
