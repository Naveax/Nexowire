#!/usr/bin/env node
// #539/#485 UI-only 403 body-privacy and retry truth probes.
// No real authentication, account, network, token or secret is used.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const CANARY = 'FAKE_CANARY_TEST_ONLY_DO_NOT_DISPLAY';
const metrics = ['users', 'users-detail', 'online-devices', 'devices-total',
  'calls', 'success-rate', 'owner-spend', 'capacity'];
const ids = [...metrics, 'admin-pill', 'admin-metrics', 'admin-error', 'admin-error-message'];
const successOverview = () => ({
  users: { total: 9, active24h: 4, paid: 1 },
  devices: { online: 2, total: 3 },
  usage: { calls24h: 12, successRate: 75 },
  infrastructure: {
    ownerPaidSpendAllowed: false,
    providerAutoUpgradeAllowed: false,
    freeCapacityPercent: null,
  },
});

function createDom() {
  const nodes = new Map(ids.map((id) => {
    const classes = new Set(id === 'admin-error' ? ['hidden'] : []);
    const attributes = new Map();
    return [id, {
      textContent: '', className: '', classes, attributes,
      classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
      setAttribute: (name, value) => attributes.set(name, String(value)),
    }];
  }));
  const pick = (id) => nodes.get(id);
  const snapshot = () => ({
    pill: pick('admin-pill').textContent,
    message: pick('admin-error-message').textContent,
    errorVisible: !pick('admin-error').classes.has('hidden'),
    busy: pick('admin-metrics').attributes.get('aria-busy') ?? null,
    values: Object.fromEntries(metrics.map((id) => [id, pick(id).textContent])),
  });
  return { nodes, snapshot };
}

function createRunner(source, fetch) {
  const ui = createDom();
  const requests = [];
  const context = {
    document: { getElementById: (id) => {
      if (!ui.nodes.has(id)) throw new Error('unexpected DOM lookup: ' + id);
      return ui.nodes.get(id);
    } },
    fetch: (...args) => { requests.push(args); return fetch(...args); },
    Intl,
  };
  return {
    init: () => runInNewContext(source, context, { filename: 'web/admin.js', timeout: 1000 }),
    reload: () => runInNewContext('load()', context, { filename: 'web/admin.js', timeout: 1000 }),
    snapshot: ui.snapshot,
    requests,
  };
}

const getOnly = (calls) => calls.every(([url, options]) =>
  url === '/api/v1/admin/overview' && options?.credentials === 'include' &&
  (options.method ?? 'GET') === 'GET');

export async function probe403Privacy(source) {
  let bodyReads = 0;
  const response = {
    ok: false, status: 403, statusText: CANARY,
    json: async () => { bodyReads++; return { token: CANARY, stack: CANARY }; },
    text: async () => { bodyReads++; return CANARY; },
  };
  const runtime = createRunner(source, async () => response);
  await runtime.init();
  const state = runtime.snapshot();
  const rendered = [state.pill, state.message, ...Object.values(state.values)].join('\n');
  const bodyHidden = !rendered.includes(CANARY) && bodyReads === 0;
  const denialNotSuccess = state.errorVisible && !/zero-spend aktif|policy ihlali/i.test(state.pill) &&
    state.message.includes('403');
  return {
    pass: bodyHidden && denialNotSuccess && runtime.requests.length === 1 && getOnly(runtime.requests),
    bodyHidden, bodyReads, denialNotSuccess, requestContract: getOnly(runtime.requests),
    state,
  };
}

export async function probeDeniedRetry(source) {
  let retryResolve;
  const delayedRetry = new Promise((resolve) => { retryResolve = resolve; });
  const responses = [
    { ok: false, status: 403 }, delayedRetry,
    { ok: true, status: 200, json: async () => successOverview() },
  ];
  const runtime = createRunner(source, async () => {
    if (!responses.length) throw new Error('extra request');
    return responses.shift();
  });
  await runtime.init();
  const denied = runtime.snapshot();
  const pending = runtime.reload();
  const waiting = runtime.snapshot();
  retryResolve({ ok: false, status: 403 });
  await pending;
  const deniedAgain = runtime.snapshot();
  await runtime.reload();
  const recovered = runtime.snapshot();
  const noPrematureAccess = denied.errorVisible && denied.message.includes('403') &&
    waiting.pill === 'Yükleniyor' && waiting.busy === 'true' && !waiting.errorVisible &&
    metrics.every((id) => waiting.values[id] === '—') &&
    deniedAgain.errorVisible && deniedAgain.message.includes('403') &&
    deniedAgain.pill !== 'Zero-spend aktif' &&
    metrics.every((id) => deniedAgain.values[id] === '—');
  const recoveryReal = recovered.pill === 'Zero-spend aktif' &&
    recovered.values.users === '9' && !recovered.errorVisible &&
    recovered.message === '' && recovered.busy === 'false';
  return {
    pass: noPrematureAccess && recoveryReal && runtime.requests.length === 3 && getOnly(runtime.requests),
    noPrematureAccess, recoveryReal, requestContract: getOnly(runtime.requests),
    denied, waiting, deniedAgain, recovered,
  };
}

export async function auditAdminAuthBoundary(source) {
  const [bodyPrivacy, deniedRetry] = await Promise.all([
    probe403Privacy(source), probeDeniedRetry(source),
  ]);
  return { pass: bodyPrivacy.pass && deniedRetry.pass, bodyPrivacy, deniedRetry };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) {
    console.error('NOT_RUN: provide exact source checkout path to web/admin.js');
    process.exitCode = 2;
  } else {
    try {
      const result = await auditAdminAuthBoundary(readFileSync(resolve(process.argv[2]), 'utf8'));
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.pass ? 0 : 1;
    } catch (error) {
      console.error('PROBE ERROR:', error instanceof Error ? error.stack : String(error));
      process.exitCode = 2;
    }
  }
}
