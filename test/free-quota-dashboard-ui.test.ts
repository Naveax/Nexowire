import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const entry = app.indexOf("$('retry').addEventListener('click', load);");
assert.ok(entry > 0, 'Dashboard entrypoint must be recognizable');

function renderUsedQuota(usedCredits: number, monthlyCredits: number | null = 1_000) {
  const nodes = new Map<string, {
    textContent: string;
    innerHTML: string;
    className: string;
    disabled: boolean;
    style: { width: string };
    classList: {
      add(name: string): void;
      remove(name: string): void;
      toggle(name: string, on?: boolean): void;
    };
  }>();
  const document = {
    getElementById(id: string) {
      if (!nodes.has(id)) {
        nodes.set(id, {
          textContent: '',
          innerHTML: '',
          className: '',
          disabled: false,
          style: { width: '' },
          classList: { add() {}, remove() {}, toggle() {} },
        });
      }
      return nodes.get(id);
    },
  };
  const snapshot = {
    displayName: 'Quota test',
    planId: 'free',
    billingMode: 'free',
    privateControlsIncluded: false,
    usage: { usedCredits, monthlyCredits },
    devices: [],
    stability: { successRate: null, medianLatencyMs: null },
  };
  const context = createContext({ document, snapshot });
  // Evaluate real dashboard code without its asynchronous auto-login startup.
  runInContext(app.slice(0, entry) + '\nrender(snapshot);', context);
  return {
    label: nodes.get('usage')?.textContent ?? '',
    progress: nodes.get('usage-bar')?.style.width ?? '',
    nextReset: (when: string) =>
      runInContext(
        'nextUtcPeriodStart(new Date(' + JSON.stringify(when) + '))',
        context,
      ) as string,
  };
}

test('Free dashboard displays normal usage without an exhaustion warning', () => {
  const view = renderUsedQuota(325);
  assert.match(view.label, /325\s*\/\s*1\.000/);
  assert.doesNotMatch(view.label, /Kota doldu/);
  assert.equal(view.progress, '33%');
});

test('Free dashboard identifies exhausted account and UTC calendar-month reset', () => {
  const view = renderUsedQuota(1_000);
  assert.match(view.label, /1\.000\s*\/\s*1\.000/);
  assert.match(view.label, /Kota doldu/);
  assert.match(view.label, /Yenilenme: \d{4}-\d{2}-01 00:00 UTC/);
  assert.equal(view.progress, '100%');
  assert.equal(view.nextReset('2026-10-06T23:55:00.000Z'), '2026-11-01');
  assert.equal(view.nextReset('2026-12-31T23:59:59.000Z'), '2027-01-01');
});

test('Reduced mid-month Free limit explains legacy usage over the new cap', () => {
  const view = renderUsedQuota(20_100);
  assert.match(view.label, /20\.100\s*\/\s*1\.000/);
  assert.match(view.label, /Kota doldu/);
  assert.equal(view.progress, '100%');
});

test('owner dashboard displays unlimited credit ceiling instead of prepaid balance', () => {
  const view = renderUsedQuota(2_005, null);
  assert.match(view.label, /Sınırsız/);
  assert.match(view.label, /2\.005/);
  assert.doesNotMatch(view.label, /Kota doldu/);
  assert.equal(view.progress, '0%');
});
