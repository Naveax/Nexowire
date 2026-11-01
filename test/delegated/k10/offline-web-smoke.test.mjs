import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { auditWebShell, PAGES, VIEWPORTS } from '../../../scripts/delegated/k10/offline-web-smoke.mjs';
import { captureLocalStaticViews, inspectPng } from '../../../scripts/delegated/k10/browser-visual-smoke.mjs';

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

test('encoded and nested local asset traversal cannot pass static smoke', (t) => {
  for (const bad of ['../../package.json', './%2e%2e/package.json', './..%2fpackage.json', '.\\..\\package.json']) {
    const webDir = fixture(t, 'index.html', (html) => html.replace('./styles.css', bad));
    assert.equal(auditWebShell(webDir).static.status, 'FAIL', bad);
  }
  const okay = fixture(t, 'index.html', (html) => html.replace('./styles.css', './styles.css?v=1#css'));
  assert.equal(auditWebShell(okay).static.status, 'PASS');
});

test('symbolic link escaping web root cannot pass even if target exists', (t) => {
  const webDir = fixture(t, 'index.html', (html) => html.replace('./styles.css', './linked.css'));
  try { symlinkSync(join(root, 'package.json'), join(webDir, 'linked.css')); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('symlink creation unavailable'); throw error; }
  assert.ok(auditWebShell(webDir).static.checks.some((c) => c.status === 'FAIL' && c.detail.startsWith('symlink escapes web/')));
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

test('twelve synthetic DOM snapshots match the scenario inventory without claiming runtime', () => {
  const inventory = JSON.parse(readFileSync(join(root, 'test/delegated/k10/state-scenarios.json'), 'utf8'));
  const set = JSON.parse(readFileSync(join(root, 'test/delegated/k10/offline-state-snapshots.json'), 'utf8'));
  assert.equal(set.evidenceKind, 'SYNTHETIC_DOM_SNAPSHOT_NOT_A_BROWSER_CAPTURE');
  assert.equal(set.cases.length, 12);
  const expected = new Set(inventory.cases.map(({ page, state }) => `${page}/${state}`));
  for (const sample of set.cases) {
    const key = `${sample.page}/${sample.state}`;
    assert.ok(expected.delete(key), `unknown or duplicate synthetic state: ${key}`);
    assert.equal(sample.runtimeStatus, 'NOT_RUN');
    assert.ok(sample.snapshot.text.length >= 5);
    assert.ok(['status', 'alert', 'region', 'list'].includes(sample.snapshot.role));
    assert.ok(readFileSync(join(realWeb, PAGES[sample.page].file), 'utf8').includes(`id="${sample.rootId}"`));
  }
  assert.equal(expected.size, 0);
});

test('focus target inventory anchors exist but keyboard tab order remains browser-only', () => {
  const inventory = JSON.parse(readFileSync(join(root, 'test/delegated/k10/focus-targets.json'), 'utf8'));
  assert.equal(inventory.browserKeyboardTest, 'NOT_RUN');
  assert.ok(inventory.targets.some((item) => item.page === 'admin' && item.targetId === null));
  for (const target of inventory.targets) {
    assert.equal(target.browserStatus, 'NOT_RUN');
    assert.ok(target.expected.length > 15 && target.precondition.length > 15);
    if (target.targetId) {
      assert.ok(readFileSync(join(realWeb, PAGES[target.page].file), 'utf8').includes(`id="${target.targetId}"`));
    }
  }
});

test('absence of Playwright returns NOT_RUN without a screenshot or false PASS', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nexowire-k10-browser-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const report = await captureLocalStaticViews({ outputDir: join(dir, 'screenshots'), playwrightModule: 'k10-missing-playwright-fixture-613901' });
  assert.equal(report.status, 'NOT_RUN');
  assert.match(report.reason, /Playwright is unavailable/);
  assert.deepEqual(report.scenarios, []);
});

function crc32ForTest(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, content) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(content.length);
  const payload = Buffer.concat([Buffer.from(type), content]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32ForTest(payload));
  return Buffer.concat([length, payload, crc]);
}

function realSyntheticPng(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

test('PNG evidence requires intact compressed pixels, chunks and viewport dimensions', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nexowire-k10-png-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const image = join(dir, 'preview.png');
  const intact = realSyntheticPng(375, 812);
  writeFileSync(image, intact);
  assert.equal(inspectPng(image, 375, 812).status, 'PASS');
  assert.equal(inspectPng(image, 768, 1024).status, 'FAIL');
  writeFileSync(image, intact.subarray(0, 24));
  assert.equal(inspectPng(image, 375, 812).status, 'FAIL');
  writeFileSync(image, intact.subarray(0, -12));
  assert.equal(inspectPng(image, 375, 812).status, 'FAIL');
  const corrupt = Buffer.from(intact);
  corrupt[40] ^= 1;
  writeFileSync(image, corrupt);
  assert.match(inspectPng(image, 375, 812).reason, /CRC/);
  writeFileSync(image, Buffer.concat([intact, Buffer.from('junk')]));
  assert.equal(inspectPng(image, 375, 812).status, 'FAIL');
  writeFileSync(image, realSyntheticPng(768, 1024));
  assert.equal(inspectPng(image, 768, 1024).status, 'PASS');
  writeFileSync(image, realSyntheticPng(1440, 900));
  assert.equal(inspectPng(image, 1440, 900).status, 'PASS');
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
