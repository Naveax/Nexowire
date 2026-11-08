import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { allowOfflineFixtureRequest, captureHostedConnectFixtures } from '../../../scripts/delegated/k10/hosted-connect-three-state.mjs';

const sha = 'b5a3f8840517d65ecbd6a018699c4c8bdde09987';
const tiny = [{ name: 'tiny', width: 1, height: 1 }];
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nexowire-k10-hosted-fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  const payload = Buffer.concat([Buffer.from(type), bytes]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, crc]);
}
function png(pixel) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, pixel, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0)),
  ]);
}
function fakeBrowserModule(dir, duplicate = false, fail = false) {
  const images = ['loading', 'error', 'success'].map((state, index) =>
    [state, png(duplicate ? 1 : index).toString('base64')]);
  const file = join(dir, 'fake-playwright.mjs');
  writeFileSync(file, `import { writeFileSync } from 'node:fs';
const images = Object.fromEntries(${JSON.stringify(images)});
export const chromium = { launch: async () => ({
  close: async () => {},
  newContext: async () => ({
    close: async () => {}, route: async () => {},
    newPage: async () => { let state = 'loading'; return {
      goto: async () => {},
      evaluate: async (_fn, value) => { if (value) { state = value; return; } return 'PASS'; },
      screenshot: async ({ path }) => {
        if (${fail}) throw new Error('file:///private/profile/token=fixture-private-data');
        writeFileSync(path, Buffer.from(images[state], 'base64'));
      },
    }; },
  }),
}) };`);
  return pathToFileURL(file).href;
}

test('#485 T-450: missing browser package retains NOT_RUN with zero screenshots', async (t) => {
  const dir = fixture(t);
  const report = await captureHostedConnectFixtures({ outputDir: join(dir, 'output'), sourceSha: sha,
    checkoutSha: sha, playwrightModule: 'nexowire-fixture-nonexistent-playwright-k10', viewports: tiny });
  assert.equal(report.status, 'NOT_RUN');
  assert.deepEqual(report.screenshots, []);
  assert.deepEqual(report.requestedViewports.map((s) => s.width), [1]);
});

test('#539 T-592: missing browser preserves all requested 320/375/768/1024 widths as NOT_RUN', async (t) => {
  const dir = fixture(t);
  const viewports = [320, 375, 768, 1024].map((width) => ({ name: `w${width}`, width, height: 800 }));
  const report = await captureHostedConnectFixtures({ outputDir: join(dir, 'output'), sourceSha: sha,
    checkoutSha: sha, playwrightModule: 'nexowire-fixture-no-browser-320', viewports });
  assert.equal(report.status, 'NOT_RUN');
  assert.deepEqual(report.requestedViewports.map((s) => s.width), [320, 375, 768, 1024]);
  assert.deepEqual(report.screenshots, []);
});

test('#485 T-450: three distinct synthetic renders hash successfully but never prove device pairing', async (t) => {
  const dir = fixture(t);
  const report = await captureHostedConnectFixtures({ outputDir: join(dir, 'output'), sourceSha: sha,
    checkoutSha: sha, playwrightModule: fakeBrowserModule(dir), viewports: tiny });
  assert.equal(report.status, 'PARTIAL_STATIC_FIXTURE');
  assert.deepEqual(report.screenshots.map((s) => s.state), ['loading', 'error', 'success']);
  assert.ok(report.screenshots.every((s) => s.status === 'CAPTURED_SYNTHETIC'));
  assert.equal(new Set(report.screenshots.map((s) => s.sha256)).size, 3);
  assert.equal(report.realPairing, 'NOT_RUN');
  assert.equal(report.windowsDeviceAcceptance, 'NOT_RUN');
  assert.equal(report.keyboardNavigation, 'NOT_RUN');
  assert.equal(report.browserOriginIndependent, 'NOT_VERIFIED');
  assert.equal(createHash('sha256').update(png(0)).digest('hex'), report.screenshots[0].sha256);
});

test('#539: identical PNG content across states produces FAIL, not a false three-state result', async (t) => {
  const dir = fixture(t);
  const report = await captureHostedConnectFixtures({ outputDir: join(dir, 'output'), sourceSha: sha,
    checkoutSha: sha, playwrightModule: fakeBrowserModule(dir, true), viewports: tiny });
  assert.equal(report.status, 'FAIL');
  assert.deepEqual(report.screenshots.map((s) => s.status), ['CAPTURED_SYNTHETIC', 'FAIL', 'FAIL']);
});

test('#539: screenshot errors are redacted from public JSON', async (t) => {
  const dir = fixture(t);
  const report = await captureHostedConnectFixtures({ outputDir: join(dir, 'output'), sourceSha: sha,
    checkoutSha: sha, playwrightModule: fakeBrowserModule(dir, false, true), viewports: tiny });
  assert.equal(report.status, 'FAIL');
  assert.doesNotMatch(JSON.stringify(report), /private\/profile|fixture-private-data|token=/);
  assert.equal(report.screenshots[0].reason, 'capture failed (details redacted)');
});

test('#485: an unpinned source cannot produce an accepted screenshot manifest', async (t) => {
  const dir = fixture(t);
  const report = await captureHostedConnectFixtures({ outputDir: join(dir, 'output'), sourceSha: 'main',
    checkoutSha: sha, playwrightModule: fakeBrowserModule(dir), viewports: tiny });
  assert.equal(report.status, 'NOT_RUN');
  assert.deepEqual(report.screenshots, []);
});

test('#539 T-452: screenshot capture rejects a stale or substituted checkout SHA', async (t) => {
  const dir = fixture(t);
  const report = await captureHostedConnectFixtures({ outputDir: join(dir, 'output'), sourceSha: sha,
    checkoutSha: '0f3916ecd3d3ff0db5d7a1743b007e52a0cd16aa',
    playwrightModule: fakeBrowserModule(dir), viewports: tiny });
  assert.equal(report.status, 'NOT_RUN');
  assert.equal(report.reason, 'source SHA differs from checked-out commit');
  assert.deepEqual(report.screenshots, []);
});

test('#485: visual fixture network isolation rejects web requests and file symlink escape', (t) => {
  const dir = fixture(t);
  const root = join(dir, 'web');
  const outside = join(dir, 'outside-secret.txt');
  const css = join(root, 'styles.css');
  const js = join(root, 'connect.js');
  mkdirSync(root);
  writeFileSync(outside, 'private');
  writeFileSync(css, 'html{}');
  writeFileSync(js, 'fetch("http://private")');
  const link = join(root, 'alias-secret.txt');
  symlinkSync(outside, link);
  assert.equal(allowOfflineFixtureRequest(pathToFileURL(css).href, root), true);
  assert.equal(allowOfflineFixtureRequest(pathToFileURL(js).href, root), false);
  assert.equal(allowOfflineFixtureRequest(pathToFileURL(link).href, root), false);
  assert.equal(allowOfflineFixtureRequest('https://example.com/token', root), false);
  assert.equal(allowOfflineFixtureRequest('http://127.0.0.1:4321/', root), false);
  assert.equal(allowOfflineFixtureRequest('data:text/plain,ok', root), true);
});
