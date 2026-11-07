import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

// Source-only, no browser, Hub, Agent, device or network. Execute the original
// render() body with a minimal in-memory DOM to expose actual displayed strings.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const app = read('web/app.js');
const connect = read('web/connect.js');
const fixture = JSON.parse(read('test/delegated/k08/issue539-status-vocabulary.json'));
const report = read('test/delegated/k08/issue539-status-vocabulary.md');

function runZeroDeviceDashboard(source = app) {
  const end = source.indexOf("\n$('folder-filter').addEventListener");
  assert.ok(end > 0, 'Original render() source not found');

  class Element {
    constructor() {
      this.textContent = '';
      this.children = [];
      this.style = {};
      this.classList = { toggle() {}, add() {} };
    }
    replaceChildren(...children) { this.children = children; }
    appendChild(child) { this.children.push(child); }
    add(option) { this.children.push(option); }
  }
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const document = {
    getElementById: get,
    querySelectorAll: () => [],
    createElement: () => new Element(),
  };
  class Option {
    constructor(text, value) { this.text = text; this.value = value; }
  }
  const script = source.slice(0, end) + `\nrender({
    displayName: 'QA', planId: 'free', billingMode: 'free',
    usage: { monthlyCredits: 100, usedCredits: 0 },
    devices: [], folders: [], autoSelectDevices: false,
  });`;
  runInNewContext(script, { document, Option, Intl, Date, Math, Set }, { timeout: 1500 });
  return {
    pill: get('connection-pill').textContent,
    count: get('devices-count').textContent,
    empty: get('devices').children[0]?.textContent,
  };
}

function checkDictionary(entries) {
  assert.equal(entries.length, 6, 'Expected six distinct evidence levels');
  assert.equal(new Set(entries.map((item) => item.state)).size, entries.length);
  assert.equal(new Set(entries.map((item) => item.label)).size, entries.length,
    'Two different evidence levels must not share a misleading Turkish status');
  for (const entry of entries) {
    assert.ok(entry.evidence?.length > 20, `Missing evidence for ${entry.state}`);
    assert.ok(entry.notEvidenceOf?.length > 20, `Missing limitation for ${entry.state}`);
  }
  const unknown = entries.find((item) => item.state === 'outcome_unknown');
  assert.match(unknown.label, /bilinmiyor/i);
  assert.match(unknown.notEvidenceOf, /replay/i);
  const done = entries.find((item) => item.state === 'task_verified');
  assert.match(done.evidence, /Independent readback/i);
}

test('T-375: actual empty-device render simultaneously displays Bağlı and no linked devices', () => {
  const actual = runZeroDeviceDashboard();
  const observed = fixture.sourceObservations[0];
  assert.deepEqual(actual, { pill: observed.pill, count: observed.count, empty: observed.empty });
  assert.equal(observed.classification, 'confirmed_source_copy_collision');
  assert.notEqual(actual.pill, observed.proposedCopy,
    'This is a reproduced copy mismatch, not a claim that the proposed UI fix is merged');
});

test('T-375: distinct Turkish status terms demand distinct independent evidence', () => {
  checkDictionary(fixture.dictionary);
  assert.throws(() => checkDictionary(fixture.dictionary.map((entry) =>
    entry.state === 'task_verified'
      ? { ...entry, label: 'İşlem sonucu bilinmiyor' }
      : entry)), /misleading Turkish status/);
  assert.throws(() => checkDictionary(fixture.dictionary.map((entry) =>
    entry.state === 'outcome_unknown'
      ? { ...entry, notEvidenceOf: 'Safe replay' }
      : entry)), /Missing limitation/);
});

test('T-375: a proposed clearer dashboard badge removes the contradiction in the same fixture', () => {
  const fixed = app.replace("setPill('Bağlı', 'good');", "setPill('Kontrol paneli yüklendi', 'good');");
  assert.notEqual(fixed, app, 'The source evidence marker must exist');
  const after = runZeroDeviceDashboard(fixed);
  assert.equal(after.pill, fixture.sourceObservations[0].proposedCopy);
  assert.equal(after.count, '0');
  assert.match(after.empty, /Henüz bağlı cihaz yok/);
  assert.equal(runZeroDeviceDashboard(app).pill, 'Bağlı',
    'The fix is only a test-local proposal; do not claim web/app.js changed');
});

test('T-375: contextual readiness and ambiguous FULL preference are reported, not silently fixed', () => {
  assert.match(connect, /setPill\('Hazır', 'good'\)/);
  assert.match(connect, /BAĞLA dediğinde cihaz hesabına eklenir/);
  assert.match(app, /modeChip\.textContent = mode === 'full' \? 'Full Access açık'/);
  assert.match(app, /const physicalCoreStatusVerifierInstalled = false/);
  assert.match(report, /#1068/);
  assert.match(report, /NOT_RUN/);
  assert.match(report, /T-375/);
  assert.match(report, /source-only/i);
});
