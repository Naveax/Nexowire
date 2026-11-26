import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { allowLocalWebAssetRequest, captureLocalStaticViews, inspectPng } from '../../../scripts/delegated/k10/browser-visual-smoke.mjs';

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

test('#539 R11 / #485: module import errors redact raw message and code canaries', async (t) => {
  const dir = disposable(t);
  for (const variant of ['message', 'code']) {
    const stub = join(dir, `import-fails-${variant}.mjs`);
    const privateMessage = 'file:///fixture-private/import-secret.mjs token=fixture-import-canary';
    writeFileSync(stub, variant === 'message'
      ? `throw new Error(${JSON.stringify(privateMessage)});`
      : `const error = new Error(${JSON.stringify(privateMessage)});
error.code = 'ERR_FIXTURE_SECRET_CANARY'; throw error;`);
    const report = await captureLocalStaticViews({
      outputDir: join(dir, 'screenshots'), playwrightModule: pathToFileURL(stub).href,
    });
    assert.equal(report.status, 'NOT_RUN');
    assert.match(report.reason, /Playwright is unavailable/);
    assert.deepEqual(report.scenarios, []);
    assert.doesNotMatch(JSON.stringify(report), /fixture-private|import-secret|fixture-import-canary|ERR_FIXTURE_SECRET_CANARY/);
  }
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

test('#539 R11: browser fixture must abort a local file request outside the web root', async (t) => {
  const dir = disposable(t);
  const outside = join(dir, 'outside-private-canary.txt');
  const decisionFile = join(dir, 'route-decision.txt');
  const stub = join(dir, 'file-route-playwright.mjs');
  writeFileSync(outside, 'not-a-web-asset');
  writeFileSync(stub, `import { writeFileSync } from 'node:fs';
const url = ${JSON.stringify(pathToFileURL(outside).href)};
const decisionFile = ${JSON.stringify(decisionFile)};
export const chromium = { launch: async () => ({
  close: async () => {},
  newContext: async () => ({
    close: async () => {},
    route: async (_pattern, handler) => {
      await handler({
        request: () => ({ url: () => url }),
        continue: async () => writeFileSync(decisionFile, 'CONTINUE'),
        abort: async () => writeFileSync(decisionFile, 'ABORT'),
      });
    },
    newPage: async () => ({ goto: async () => { throw new Error('fixture stops before screenshot'); } }),
  }),
}) };`);
  const report = await captureLocalStaticViews({
    outputDir: join(dir, 'screenshots'), playwrightModule: pathToFileURL(stub).href,
  });
  assert.equal(report.status, 'FAIL'); // No actual page was loaded.
  assert.equal(readFileSync(decisionFile, 'utf8'), 'ABORT');
});

test('#539 R11: static assets inside web are permitted; symlink escapes and HTTP remain denied', (t) => {
  const dir = disposable(t);
  const webRoot = join(dir, 'web');
  mkdirSync(webRoot);
  const safeCss = join(webRoot, 'styles.css');
  const outsideDir = join(dir, 'outside-dir');
  mkdirSync(outsideDir);
  const outside = join(outsideDir, 'secrets.txt');
  writeFileSync(safeCss, 'body{}');
  writeFileSync(outside, 'private');
  // Windows unprivileged runners cannot reliably create file symlinks.
  // An external-directory junction checks realpath escape without that privilege.
  const linkedDir = join(webRoot, 'linked-outside-dir');
  symlinkSync(outsideDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(allowLocalWebAssetRequest(pathToFileURL(safeCss).href, webRoot), true);
  assert.equal(allowLocalWebAssetRequest('data:text/plain,fixture', webRoot), true);
  assert.equal(allowLocalWebAssetRequest(pathToFileURL(outside).href, webRoot), false);
  assert.equal(allowLocalWebAssetRequest(pathToFileURL(join(linkedDir, 'secrets.txt')).href, webRoot), false);
  if (process.platform !== 'win32') {
    const link = join(webRoot, 'linked-secrets.txt');
    symlinkSync(outside, link);
    assert.equal(allowLocalWebAssetRequest(pathToFileURL(link).href, webRoot), false);
  }
  assert.equal(allowLocalWebAssetRequest('http://127.0.0.1:8080/', webRoot), false);
  assert.equal(allowLocalWebAssetRequest('file:///definitely-missing-private-file.txt', webRoot), false);
});

function k10Crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function k10PngChunk(type, bytes) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  const payload = Buffer.concat([Buffer.from(type), bytes]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(k10Crc32(payload));
  return Buffer.concat([header, payload, checksum]);
}

test('#485: unknown critical PNG chunk fails despite valid CRC, dimensions and pixel stream', () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    k10PngChunk('IHDR', ihdr),
    k10PngChunk('ABCD', Buffer.from('unknown critical fixture')),
    k10PngChunk('IDAT', deflateSync(Buffer.from([0, 17, 0, 0, 255]))),
    k10PngChunk('IEND', Buffer.alloc(0)),
  ]);
  assert.match(inspectPng(png, 1, 1).reason, /critical PNG chunk/);
  assert.equal(inspectPng(png, 1, 1).status, 'FAIL');
});

test('#485: IDAT interrupted by ancillary chunk fails while contiguous split IDAT passes', () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const compressed = deflateSync(Buffer.from([0, 17, 0, 0, 255]));
  const prefix = [
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    k10PngChunk('IHDR', ihdr),
    k10PngChunk('IDAT', compressed.subarray(0, 3)),
  ];
  const suffix = [
    k10PngChunk('IDAT', compressed.subarray(3)),
    k10PngChunk('IEND', Buffer.alloc(0)),
  ];
  assert.equal(inspectPng(Buffer.concat([...prefix, ...suffix]), 1, 1).status, 'PASS');
  const invalid = Buffer.concat([...prefix, k10PngChunk('tEXt', Buffer.from('k\\0v')), ...suffix]);
  assert.match(inspectPng(invalid, 1, 1).reason, /nonconsecutive PNG IDAT/);
  assert.equal(inspectPng(invalid, 1, 1).status, 'FAIL');
});


test('#539 R11 / #485: context creation failure is redacted FAIL, not an uncaught rejection', async (t) => {
  const dir = disposable(t);
  const stub = join(dir, 'context-fails.mjs');
  writeFileSync(stub, `export const chromium = {launch: async () => ({
    close: async () => {},
    newContext: async () => { throw new Error('file:///fixture-private/context.json token=K10_CONTEXT_CANARY'); }
  })};`);
  const report = await captureLocalStaticViews({
    outputDir: join(dir, 'output'), playwrightModule: pathToFileURL(stub).href,
  });
  assert.equal(report.status, 'FAIL');
  assert.equal(report.scenarios.length, 9);
  assert.ok(report.scenarios.every((s) => s.layout === 'FAIL' && s.screenshot === null));
  assert.ok(report.scenarios.every((s) => s.keyboardFocus === 'NOT_RUN'));
  assert.doesNotMatch(JSON.stringify(report), /fixture-private|context\.json|K10_CONTEXT_CANARY/);
});

// Teardown failure must not be hidden behind otherwise valid synthetic PNGs.
for (const failure of ['browser', 'context', 'none']) {
  test(`#539 R11: ${failure} teardown result is explicit and redacted`, async (t) => {
    const dir = disposable(t);
    const stub = join(dir, 'cleanup-fails.mjs');
    writeFileSync(stub, `import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
${k10Crc32.toString()}
${k10PngChunk.toString()}
const failure = ${JSON.stringify(failure)};
const close = async (kind) => {
  if (failure === kind) throw new Error('file:///fixture-private/cleanup.json token=K10_CLEANUP_CANARY');
};
export const chromium = { launch: async () => ({
  close: () => close('browser'),
  newContext: async ({ viewport }) => ({
    close: () => close('context'), route: async () => {},
    newPage: async () => ({ goto: async () => {}, evaluate: async () => 'PASS',
      screenshot: async ({path}) => {
        const h = Buffer.alloc(13); h.writeUInt32BE(viewport.width); h.writeUInt32BE(viewport.height, 4); h[8]=8; h[9]=6;
        writeFileSync(path, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), k10PngChunk('IHDR', h), k10PngChunk('IDAT', deflateSync(Buffer.alloc((viewport.width * 4 + 1) * viewport.height))), k10PngChunk('IEND', Buffer.alloc(0))]));
      }
    })
  })
}) };`);
    const report = await captureLocalStaticViews({outputDir: join(dir, 'screenshots'), playwrightModule: pathToFileURL(stub).href});
    assert.equal(report.status, failure === 'none' ? 'PARTIAL' : 'FAIL');
    assert.equal(report.browserCleanup, failure === 'browser' ? 'FAIL' : 'PASS');
    assert.equal(report.scenarios.length, 9);
    assert.ok(report.scenarios.every((s) => s.png.status === 'PASS'));
    assert.ok(report.scenarios.every((s) => s.contextCleanup === (failure === 'context' ? 'FAIL' : 'PASS')));
    assert.doesNotMatch(JSON.stringify(report), /fixture-private|cleanup\.json|K10_CLEANUP_CANARY/);
    assert.equal(report.authenticatedStates, 'NOT_RUN');
  });
}
