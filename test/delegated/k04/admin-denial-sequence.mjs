#!/usr/bin/env node
// Issue #539/R11: offline admin UI state probe; no real credentials or HTTP traffic.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const metricIds = [
  'users', 'users-detail', 'online-devices', 'devices-total',
  'calls', 'success-rate', 'owner-spend', 'capacity',
];
const allIds = [
  ...metricIds, 'admin-pill', 'admin-metrics', 'admin-error', 'admin-error-message',
];
const overview = () => ({
  users: { total: 7, active24h: 4, paid: 1 },
  devices: { total: 3, online: 2 },
  usage: { calls24h: 16, successRate: 75 },
  infrastructure: {
    ownerPaidSpendAllowed: false,
    providerAutoUpgradeAllowed: false,
    freeCapacityPercent: null,
  },
});

function dom() {
  return new Map(allIds.map((id) => {
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
      setAttribute: (key, value) => attrs.set(key, String(value)),
    }];
  }));
}

export async function probeAdminSequence(source, deniedStatus) {
  if (![401, 403, 503].includes(deniedStatus)) {
    throw new RangeError('HTTP denial status must be 401, 403 or 503');
  }
  const nodes = dom();
  const requests = [];
  const responses = [
    { ok: true, status: 200, json: async () => overview() },
    { ok: false, status: deniedStatus },
  ];
  const context = {
    document: { getElementById: (id) => {
      if (!nodes.has(id)) throw new Error('unknown element: ' + id);
      return nodes.get(id);
    } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (!responses.length) throw new Error('unexpected third HTTP request');
      return responses.shift();
    },
    Intl,
  };
  const snapshot = () => ({
    pill: nodes.get('admin-pill').textContent,
    statusClass: nodes.get('admin-pill').className,
    errorMessage: nodes.get('admin-error-message').textContent,
    errorVisible: !nodes.get('admin-error').classes.has('hidden'),
    metrics: Object.fromEntries(metricIds.map((id) => [id, nodes.get(id).textContent])),
    busy: nodes.get('admin-metrics').attrs.get('aria-busy') ?? null,
  });
  await runInNewContext(source, context, { filename: 'web/admin.js', timeout: 1000 });
  const before = snapshot();
  await runInNewContext('load()', context, { filename: 'web/admin.js', timeout: 1000 });
  const after = snapshot();
  const requestContract = requests.length === 2 && requests.every(({ url, options }) =>
    url === '/api/v1/admin/overview' &&
    options?.credentials === 'include' &&
    (options.method ?? 'GET') === 'GET');
  const baselineSuccess = before.pill === 'Zero-spend aktif' && before.metrics.users === '7';
  const noStaleSuccess = metricIds.every((id) => after.metrics[id] === '—') &&
    after.pill !== 'Zero-spend aktif' && after.busy !== 'true';
  const denialDisplayed = after.errorVisible && after.errorMessage.includes(String(deniedStatus));
  const noFalseOffline = deniedStatus === 503 || after.pill !== 'Offline';
  return {
    deniedStatus,
    requestContract,
    baselineSuccess,
    noStaleSuccess,
    denialDisplayed,
    noFalseOffline,
    pass: requestContract && baselineSuccess && noStaleSuccess && denialDisplayed && noFalseOffline,
    before,
    after,
  };
}

export async function auditAdminDenials(source) {
  const cases = [];
  for (const status of [401, 403, 503]) cases.push(await probeAdminSequence(source, status));
  const auth = cases.filter((item) => item.deniedStatus !== 503);
  const distinctAuthMessages = auth[0].after.errorMessage !== auth[1].after.errorMessage;
  return {
    source: 'offline-vm',
    passed: cases.filter((item) => item.pass).length,
    total: cases.length,
    distinctAuthMessages,
    cases,
    pass: cases.every((item) => item.pass) && distinctAuthMessages,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) {
    console.error('NOT_RUN: supply exact checked-out web/admin.js path');
    process.exitCode = 2;
  } else {
    try {
      const report = await auditAdminDenials(readFileSync(resolve(process.argv[2]), 'utf8'));
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.pass ? 0 : 1;
    } catch (error) {
      console.error('PROBE ERROR:', error instanceof Error ? error.stack : String(error));
      process.exitCode = 2;
    }
  }
}
