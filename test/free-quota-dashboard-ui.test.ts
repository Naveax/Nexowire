import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const entry = app.indexOf("$('folder-filter').addEventListener('change'");
assert.ok(entry > 0, 'Dashboard event bootstrap must be recognizable');

interface ViewNode {
  textContent: string;
  innerHTML: string;
  className: string;
  title: string;
  value: string;
  disabled: boolean;
  style: {width: string};
  classList: {add(name: string): void; remove(name: string): void; toggle(name: string, on?: boolean): void};
  replaceChildren(...args: unknown[]): void;
  add(value: unknown): void;
  appendChild(value: unknown): void;
}
function renderUsedQuota(usedCredits: number, monthlyCredits: number | null = 1_000) {
  const nodes = new Map<string, ViewNode>();
  const makeNode = (): ViewNode => ({
    textContent: '', innerHTML: '', className: '', title: '', value: '', disabled: false,
    style: { width: '' },
    classList: { add() {}, remove() {}, toggle() {} },
    replaceChildren() {},
    add() {},
    appendChild() {},
  });
  const document = {
    getElementById(id: string): ViewNode {
      if (!nodes.has(id)) nodes.set(id, makeNode());
      return nodes.get(id)!;
    },
    querySelectorAll() { return []; },
    createElement() { return makeNode(); },
  };
  const snapshot = {
    displayName: 'Quota test',
    planId: 'free',
    billingMode: 'free',
    privateControlsIncluded: false,
    usage: { usedCredits, monthlyCredits },
    folders: [],
    devices: [],
    stability: { successRate: null, medianLatencyMs: null },
  };
  const context = createContext({
    document, snapshot,
    Option: class {
      constructor(public readonly text: string, public readonly value: string) {}
    },
  });
  // Evaluate the real render logic; event/bootstrap work is tested in the browser suite.
  runInContext(app.slice(0, entry) + '\nrender(snapshot);', context);
  return {
    label: nodes.get('usage')?.textContent ?? '',
    exact: nodes.get('usage')?.title ?? '',
    detail: nodes.get('usage-detail')?.textContent ?? '',
    progress: nodes.get('usage-bar')?.style.width ?? '',
    nextReset: (when: string) =>
      runInContext('nextUtcPeriodStart(new Date(' + JSON.stringify(when) + '))', context) as string,
  };
}

test('Free dashboard shows compact usage, exact tooltip and a normal quota status', () => {
  const view = renderUsedQuota(325);
  assert.match(view.label, /^325\s*\/\s*1k$/);
  assert.match(view.exact, /^325\s*\/\s*1\.000$/);
  assert.doesNotMatch(view.detail, /Kota doldu/);
  assert.equal(view.progress, '33%');
});

test('Free dashboard identifies exhausted account and UTC calendar-month reset', () => {
  const view = renderUsedQuota(1_000);
  assert.match(view.label, /^1k\s*\/\s*1k$/);
  assert.match(view.detail, /Kota doldu/);
  assert.match(view.detail, /Yenilenme: \d{4}-\d{2}-01 00:00 UTC/);
  assert.equal(view.progress, '100%');
  assert.equal(view.nextReset('2026-10-06T23:55:00.000Z'), '2026-11-01');
  assert.equal(view.nextReset('2026-12-31T23:59:59.000Z'), '2027-01-01');
});

test('Reduced mid-month Free limit handles large legacy usage', () => {
  const view = renderUsedQuota(20_100);
  assert.match(view.label, /^20\.1k\s*\/\s*1k$/);
  assert.match(view.exact, /^20\.100\s*\/\s*1\.000$/);
  assert.match(view.detail, /Kota doldu/);
  assert.equal(view.progress, '100%');
});

test('owner dashboard shows unlimited quota without exposing a prepaid balance', () => {
  const view = renderUsedQuota(2_005, null);
  assert.equal(view.label, '2k');
  assert.equal(view.exact, '2.005');
  assert.match(view.detail, /Sınırsız/);
  assert.doesNotMatch(view.detail, /Kota doldu/);
  assert.equal(view.progress, '0%');
});
