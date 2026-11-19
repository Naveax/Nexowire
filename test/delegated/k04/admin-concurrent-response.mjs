#!/usr/bin/env node
// Issue #539: purely local DOM/VM repro for out-of-order admin overview responses.
// Does not perform network requests or make authorization decisions.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const metricIds = ['users', 'users-detail', 'online-devices', 'devices-total',
  'calls', 'success-rate', 'owner-spend', 'capacity'];
const ids = [...metricIds, 'admin-pill', 'admin-metrics', 'admin-error', 'admin-error-message'];
const overview = () => ({
  users: { total: 3, active24h: 1, paid: 0 },
  devices: { online: 1, total: 2 },
  usage: { calls24h: 4, successRate: 100 },
  infrastructure: { ownerPaidSpendAllowed: false, providerAutoUpgradeAllowed: false,
    freeCapacityPercent: null },
});

function dom() {
  const nodes = new Map(ids.map((id) => {
    const classes = new Set(id === 'admin-error' ? ['hidden'] : []);
    const attrs = new Map();
    return [id, { textContent: '', className: '',
      classList: { add: (key) => classes.add(key), remove: (key) => classes.delete(key),
        contains: (key) => classes.has(key) },
      setAttribute: (key, value) => attrs.set(key, String(value)),
      getAttribute: (key) => attrs.get(key) ?? null,
    }];
  }));
  const snapshot = () => ({
    pill: nodes.get('admin-pill').textContent,
    users: nodes.get('users').textContent,
    errorVisible: !nodes.get('admin-error').classList.contains('hidden'),
    errorMessage: nodes.get('admin-error-message').textContent,
    busy: nodes.get('admin-metrics').getAttribute('aria-busy'),
  });
  return { nodes, snapshot };
}

export async function probeOutOfOrder(source, olderStatus, newerStatus) {
  if (![200, 403].includes(olderStatus) || ![200, 403].includes(newerStatus) ||
      olderStatus === newerStatus) throw new RangeError('expected opposite 200/403 statuses');
  const ui = dom();
  const requests = [];
  let settleOlder;
  const olderPending = new Promise((resolve) => { settleOlder = resolve; });
  const response = (status) => status === 200
    ? { ok: true, status, json: async () => overview() }
    : { ok: false, status };
  const context = {
    document: { getElementById: (id) => {
      if (!ui.nodes.has(id)) throw new Error('unexpected DOM id ' + id);
      return ui.nodes.get(id);
    } },
    fetch: (url, options) => {
      requests.push({ url, options });
      if (requests.length === 1) return olderPending;
      if (requests.length === 2) return Promise.resolve(response(newerStatus));
      throw new Error('unexpected third request');
    },
    Intl,
  };
  const older = runInNewContext(source, context, { filename: 'web/admin.js', timeout: 1000 });
  const newer = runInNewContext('load()', context, { filename: 'web/admin.js', timeout: 1000 });
  await newer;
  const latest = ui.snapshot();
  settleOlder(response(olderStatus));
  await older;
  const afterLate = ui.snapshot();
  const expectedLatest = newerStatus === 200
    ? latest.pill === 'Zero-spend aktif' && latest.users === '3' && !latest.errorVisible
    : latest.pill === 'Yetki yetersiz' && latest.users === '—' &&
      latest.errorVisible && latest.errorMessage.includes('403');
  const requestContract = requests.length === 2 && requests.every(({ url, options }) =>
    url === '/api/v1/admin/overview' && options?.credentials === 'include' &&
    (options.method ?? 'GET') === 'GET');
  const stable = JSON.stringify(latest) === JSON.stringify(afterLate);
  return { olderStatus, newerStatus, pass: expectedLatest && requestContract && stable,
    expectedLatest, requestContract, stable, latest, afterLate };
}

export async function auditOutOfOrder(source) {
  const cases = [
    await probeOutOfOrder(source, 200, 403),
    await probeOutOfOrder(source, 403, 200),
  ];
  return { pass: cases.every((item) => item.pass), passed: cases.filter((item) => item.pass).length,
    total: cases.length, cases };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) {
    console.error('NOT_RUN: supply exact checked-out web/admin.js');
    process.exitCode = 2;
  } else {
    try {
      const report = await auditOutOfOrder(readFileSync(resolve(process.argv[2]), 'utf8'));
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.pass ? 0 : 1;
    } catch (error) {
      console.error('PROBE ERROR:', error instanceof Error ? error.stack : String(error));
      process.exitCode = 2;
    }
  }
}
