import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { auditBrowserScreenshot, auditIndependentScreenshotCaptures } from './browser-screenshot-evidence.mjs';

const SHA = 'b5a3f8840517d65ecbd6a018699c4c8bdde09987';
// Public tiny 1x1 PNG fixture. It is deliberately NOT a real viewport capture.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y2W7J4AAAAASUVORK5CYII=', 'base64');
const screenshotSha256 = createHash('sha256').update(PNG).digest('hex');

function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'nexowire-k02-screenshot-'));
  try {
    writeFileSync(join(dir, 'viewport-1.png'), PNG);
    const evidence = { sourceSha: SHA, captureState: 'completed', attempted: true,
      screenshotFile: 'viewport-1.png', screenshotSha256, screenshotScale: 'css',
      observedInnerWidth: 1, documentScrollWidth: 1, unknownVisible: true,
      overflowIds: [], browserVersion: 'Chromium fixture / not real hosted capture' };
    return fn({ dir, evidence });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const evaluate = (dir, evidence, overrides = {}) => auditBrowserScreenshot({
  evidence: { ...evidence, ...overrides }, evidenceDir: dir, expectedSha: SHA, targetCssWidth: 1,
});

test('no actual browser run is explicitly NOT_RUN even when CI was green', () => {
  withFixture(({ dir, evidence }) => {
    assert.equal(evaluate(dir, evidence, { captureState: 'not_run', workflowConclusion: 'success' }).status, 'NOT_RUN');
    assert.equal(evaluate(dir, evidence, { captureState: undefined }).status, 'NOT_RUN');
  });
});

test('queued capture remains PENDING; stale commit is UNKNOWN', () => {
  withFixture(({ dir, evidence }) => {
    assert.equal(evaluate(dir, evidence, { captureState: 'queued' }).status, 'PENDING');
    assert.equal(evaluate(dir, evidence, { sourceSha: '0'.repeat(40) }).status, 'UNKNOWN');
  });
});

test('attempted capture with absent screenshot is FAIL, unattempted is NOT_RUN', () => {
  withFixture(({ dir, evidence }) => {
    assert.equal(evaluate(dir, evidence, { screenshotFile: 'missing.png' }).status, 'FAIL');
    assert.equal(evaluate(dir, evidence, { screenshotFile: 'missing.png', attempted: false }).status, 'NOT_RUN');
  });
});

test('path traversal and ambiguous basenames are refused', () => {
  withFixture(({ dir, evidence }) => {
    assert.equal(evaluate(dir, evidence, { screenshotFile: '../secret.png' }).status, 'FAIL');
    assert.equal(evaluate(dir, evidence, { screenshotFile: 'name..png' }).status, 'FAIL');
  });
});

test('a forged file with PNG extension is rejected', () => {
  withFixture(({ dir, evidence }) => {
    writeFileSync(join(dir, 'fake.png'), 'this is not a PNG');
    assert.equal(evaluate(dir, evidence, { screenshotFile: 'fake.png' }).status, 'FAIL');
  });
});

test('artifact checksum and dimensions cannot be overridden with CI success', () => {
  withFixture(({ dir, evidence }) => {
    assert.equal(evaluate(dir, evidence, { screenshotSha256: '0'.repeat(64), workflowConclusion: 'success' }).status, 'FAIL');
    assert.equal(auditBrowserScreenshot({ evidence, evidenceDir: dir, expectedSha: SHA, targetCssWidth: 320 }).status, 'UNKNOWN');
    assert.equal(auditBrowserScreenshot({ evidence: { ...evidence, observedInnerWidth: 320 },
      evidenceDir: dir, expectedSha: SHA, targetCssWidth: 320 }).status, 'FAIL');
  });
});

test('reported horizontal overflow or hidden UNKNOWN fails even with a PNG', () => {
  withFixture(({ dir, evidence }) => {
    assert.equal(evaluate(dir, evidence, { documentScrollWidth: 2 }).status, 'FAIL');
    assert.equal(evaluate(dir, evidence, { unknownVisible: false }).status, 'FAIL');
    assert.equal(evaluate(dir, evidence, { overflowIds: ['device-name'] }).status, 'FAIL');
  });
});

test('incomplete viewport or browser provenance is UNKNOWN', () => {
  withFixture(({ dir, evidence }) => {
    assert.equal(evaluate(dir, evidence, { browserVersion: null }).status, 'UNKNOWN');
    assert.equal(evaluate(dir, evidence, { observedInnerWidth: null }).status, 'UNKNOWN');
    assert.equal(evaluate(dir, evidence, { screenshotScale: 'unknown' }).status, 'UNKNOWN');
  });
});

test('even self-consistent tiny fixture is REVIEW_REQUIRED and never PASS', () => {
  withFixture(({ dir, evidence }) => {
    const outcome = evaluate(dir, evidence);
    assert.equal(outcome.status, 'REVIEW_REQUIRED');
    assert.match(outcome.reason, /authenticity unverified/);
  });
});

test('same screenshot digest reused under another capture ID is not independent proof', () => {
  withFixture(({ dir, evidence }) => {
    const checks = auditIndependentScreenshotCaptures({ expectedSha: SHA, evidenceDir: dir,
      captures: [
        { evidence: { ...evidence, captureId: 'attempt-001' }, targetCssWidth: 1 },
        { evidence: { ...evidence, captureId: 'attempt-002' }, targetCssWidth: 1 },
      ] });
    assert.deepEqual(checks.map(x => x.status), ['REVIEW_REQUIRED', 'REPLAY_UNVERIFIED']);
    assert.match(checks[1].reason, /identical PNG digest/);
  });
});

test('same capture identity or missing identity never proves two hosted runs', () => {
  withFixture(({ dir, evidence }) => {
    const same = auditIndependentScreenshotCaptures({ expectedSha: SHA, evidenceDir: dir,
      captures: [
        { evidence: { ...evidence, captureId: 'same-id' }, targetCssWidth: 1 },
        { evidence: { ...evidence, captureId: 'same-id' }, targetCssWidth: 1 },
        { evidence: { ...evidence }, targetCssWidth: 1 },
      ] });
    assert.deepEqual(same.map(x => x.status), ['REVIEW_REQUIRED', 'REPLAY_UNVERIFIED', 'UNKNOWN']);
  });
});

test('a forged second digest stays FAIL, not independent capture evidence', () => {
  withFixture(({ dir, evidence }) => {
    const checks = auditIndependentScreenshotCaptures({ expectedSha: SHA, evidenceDir: dir,
      captures: [
        { evidence: { ...evidence, captureId: 'a' }, targetCssWidth: 1 },
        { evidence: { ...evidence, captureId: 'b', screenshotSha256: '0'.repeat(64) }, targetCssWidth: 1 },
      ] });
    assert.deepEqual(checks.map(x => x.status), ['REVIEW_REQUIRED', 'FAIL']);
  });
});
