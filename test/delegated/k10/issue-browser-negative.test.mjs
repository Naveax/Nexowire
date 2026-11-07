import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { captureLocalStaticViews } from '../../../scripts/delegated/k10/browser-visual-smoke.mjs';

function disposable(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nexowire-browser-proof-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('#539 R11: missing browser package never claims screenshot PASS or creates artifacts', async (t) => {
  const dir = disposable(t);
  const result = await captureLocalStaticViews({
    outputDir: join(dir, 'screenshots'),
    playwrightModule: 'k10-fixture-missing-playwright-package-77011',
  });
  assert.equal(result.status, 'NOT_RUN');
  assert.deepEqual(result.scenarios, []);
  assert.ok(!JSON.stringify(result).includes('PASS'));
});

test('#539 R11 / #485: browser startup failure redacts local path and bearer-like data', async (t) => {
  const dir = disposable(t);
  const stub = join(dir, 'launch-fails.mjs');
  writeFileSync(stub, `export const chromium = {launch: async () => {
    throw new Error('failed /private/onur/agent/secret.json bearer=fixture-canary-value');
  }};`);
  const report = await captureLocalStaticViews({ outputDir: join(dir, 'output'), playwrightModule: pathToFileURL(stub).href });
  assert.equal(report.status, 'NOT_RUN');
  assert.match(report.reason, /Chromium could not start/);
  assert.doesNotMatch(JSON.stringify(report), /private\/onur|secret\.json|fixture-canary-value/);
  assert.deepEqual(report.scenarios, []);
});

test('#539 R11 / #485: per-page failure is FAIL and never leaks filesystem path', async (t) => {
  const dir = disposable(t);
  const stub = join(dir, 'page-fails.mjs');
  writeFileSync(stub, `export const chromium = {launch: async () => ({
    close: async () => {},
    newContext: async () => ({
      close: async () => {},
      route: async () => {},
      newPage: async () => ({
        goto: async () => { throw new Error('file:///private/onur/hidden.html token=fixture-secret'); }
      })
    })
  })};`);
  const report = await captureLocalStaticViews({ outputDir: join(dir, 'output'), playwrightModule: pathToFileURL(stub).href });
  assert.equal(report.status, 'FAIL');
  assert.equal(report.scenarios.length, 9);
  assert.ok(report.scenarios.every((s) => s.layout === 'FAIL' && s.screenshot === null));
  assert.ok(report.scenarios.every((s) => s.keyboardFocus === 'NOT_RUN'));
  assert.doesNotMatch(JSON.stringify(report), /private\/onur|hidden\.html|fixture-secret/);
});

test('#539 R11: output directory error remains NOT_RUN and redacts local path', async (t) => {
  const dir = disposable(t);
  const stub = join(dir, 'minimal-browser.mjs');
  writeFileSync(stub, 'export const chromium = {launch: async () => ({close: async () => {}})};');
  writeFileSync(join(dir, 'not-a-directory'), 'private fixture path');
  const report = await captureLocalStaticViews({
    outputDir: join(dir, 'not-a-directory', 'screenshots'),
    playwrightModule: pathToFileURL(stub).href,
  });
  assert.equal(report.status, 'NOT_RUN');
  assert.match(report.reason, /output directory is unavailable/);
  assert.doesNotMatch(JSON.stringify(report), /not-a-directory|private fixture path/);
});
