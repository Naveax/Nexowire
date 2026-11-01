import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { auditWebShell, PAGES, VIEWPORTS } from '../../../scripts/delegated/k10/offline-web-smoke.mjs';
import { inspectPng } from '../../../scripts/delegated/k10/browser-visual-smoke.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const realWeb = join(root, 'web');

function fixture(t, file, transform) {
  const dir = mkdtempSync(join(tmpdir(), 'nexowire-k10-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(realWeb, dir, { recursive: true });
  if (file) {
    const path = join(dir, file);
    writeFileSync(path, transform(readFileSync(path, 'utf8')));
  }
  return dir;
}

test('real dashboard, connect and admin sources pass offline references and markup checks', () => {
  const report = auditWebShell(realWeb);
  assert.equal(report.static.status, 'PASS', JSON.stringify(report.static.checks.filter((c) => c.status === 'FAIL')));
  assert.ok(report.static.passed >= 30);
  assert.deepEqual(Object.keys(PAGES), ['dashboard', 'connect', 'admin']);
});

test('missing CSS asset cannot claim static PASS', (t) => {
  const webDir = fixture(t, 'connect.html', (html) => html.replace('./styles.css', './missing.css'));
  const report = auditWebShell(webDir);
  assert.equal(report.static.status, 'FAIL');
  assert.ok(report.static.checks.some((c) => c.page === 'connect' && c.rule === 'asset-reference' && c.status === 'FAIL'));
});

test('missing module entrypoint fails the check', (t) => {
  const webDir = fixture(t, 'index.html', (html) => html.replace('./app.js', './does-not-exist.js'));
  assert.equal(auditWebShell(webDir).static.status, 'FAIL');
});

test('duplicate IDs, missing required IDs, and missing viewport metadata fail', (t) => {
  const webDir = fixture(t, 'admin.html', (html) => html.replace('id="admin-error"', 'id="admin-pill"').replace('name="viewport"', 'name="other"'));
  const checks = auditWebShell(webDir).static.checks.filter((c) => c.page === 'admin' && c.status === 'FAIL');
  assert.ok(checks.some((c) => c.rule === 'unique-ids'));
  assert.ok(checks.some((c) => c.rule === 'required-id:admin-error'));
  assert.ok(checks.some((c) => c.rule === 'viewport-meta'));
});

test('asset directory escape is rejected even if its target exists', (t) => {
  const webDir = fixture(t, 'index.html', (html) => html.replace('./styles.css', '../package.json'));
  assert.ok(auditWebShell(webDir).static.checks.some((c) => c.status === 'FAIL' && c.detail.startsWith('path escapes web/')));
});

test('test widths do not imply a browser, overflow, focus or screenshot PASS', () => {
  const report = auditWebShell(realWeb);
  assert.deepEqual(VIEWPORTS.map(({ width }) => width), [375, 768, 1440]);
  assert.equal(report.visual.scenarios.length, 9);
  assert.equal(report.visual.status, 'NOT_RUN');
  assert.equal(report.accountAndDevice.status, 'NOT_RUN');
  for (const scenario of report.visual.scenarios) {
    assert.equal(scenario.layout, 'NOT_RUN');
    assert.equal(scenario.overflow, 'NOT_RUN');
    assert.equal(scenario.keyboardFocus, 'NOT_RUN');
    assert.equal(scenario.screenshot, null);
  }
});

test('report schema is serializable and preserves evidence boundaries', () => {
  const report = JSON.parse(JSON.stringify(auditWebShell(realWeb)));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.static.status, 'PASS');
  assert.equal(report.visual.status, 'NOT_RUN');
});

test('twelve state fixtures bind to existing DOM anchors but retain NOT_RUN browser evidence', () => {
  const fixtureManifest = JSON.parse(readFileSync(join(root, 'test/delegated/k10/state-scenarios.json'), 'utf8'));
  assert.equal(fixtureManifest.schemaVersion, 1);
  assert.equal(fixtureManifest.cases.length, 12);
  const combinations = new Set();
  for (const item of fixtureManifest.cases) {
    assert.ok(PAGES[item.page], `unknown page ${item.page}`);
    const identity = `${item.page}:${item.state}`;
    assert.ok(!combinations.has(identity), `duplicate state ${identity}`);
    combinations.add(identity);
    assert.equal(item.browserStatus, 'NOT_RUN');
    assert.ok(item.trigger.length >= 12);
    const html = readFileSync(join(realWeb, PAGES[item.page].file), 'utf8');
    for (const anchor of item.anchors) {
      assert.ok(html.includes(`id="${anchor}"`), `${identity}: missing #${anchor}`);
    }
  }
  for (const page of Object.keys(PAGES)) {
    for (const state of ['loading', 'empty', 'error', 'success']) {
      assert.ok(combinations.has(`${page}:${state}`));
    }
  }
});

test('PNG evidence validation rejects incorrect dimensions and missing headers', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nexowire-k10-png-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const image = join(dir, 'preview.png');
  const header = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
  header.write('IHDR', 12);
  header.writeUInt32BE(375, 16);
  header.writeUInt32BE(812, 20);
  writeFileSync(image, header);
  assert.equal(inspectPng(image, 375, 812).status, 'PASS');
  assert.equal(inspectPng(image, 768, 1024).status, 'FAIL');
  writeFileSync(image, Buffer.alloc(24));
  assert.equal(inspectPng(image, 375, 812).status, 'FAIL');
});

test('review template never promotes empty browser evidence to PASS', () => {
  const template = JSON.parse(readFileSync(join(root, 'docs/delegated/browser-evidence-k10/template.json'), 'utf8'));
  assert.equal(template.schemaVersion, 1);
  assert.equal(template.exactSourceSha, null);
  assert.equal(template.sourceChecks.status, 'NOT_RUN');
  assert.equal(template.browserScreenshots.status, 'NOT_RUN');
  assert.deepEqual(template.browserScreenshots.cases, []);
  assert.equal(template.keyboardFocus.status, 'NOT_RUN');
  assert.equal(template.authenticatedStates.status, 'NOT_RUN');
  assert.equal(template.physicalDeviceAcceptance.status, 'NOT_RUN');
  assert.equal(template.reviewDecision, 'NEEDS_BROWSER');
});
