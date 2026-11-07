import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { auditConsoleIndicator, evaluateConnectEvidence } from '../../../scripts/delegated/k10/issue-evidence-contract.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nexowire-issue-evidence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const sha = '4e7db16f4233048a956664bef6b607781eb63fb7';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let n = 0; n < 8; n++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, bytes) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  const payload = Buffer.concat([Buffer.from(type), bytes]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, crc]);
}

function tinySyntheticPng(pixel = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, pixel, 0, 0, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('#485: three screenshots missing must never become a browser PASS', (t) => {
  const dir = fixture(t);
  const report = evaluateConnectEvidence({ sourceSha: sha, screenshots: [] }, dir);
  assert.equal(report.artifactStatus, 'NOT_RUN');
  assert.deepEqual(report.cases.map((c) => c.state), ['loading', 'error', 'success']);
  assert.ok(report.cases.every((c) => c.status === 'NOT_RUN'));
  assert.equal(report.realUserPairing, 'NOT_RUN');
  assert.equal(report.windowsAcceptance, 'NOT_RUN');
});

test('#485: source-linked three-state plan stays NOT_RUN without actual images', (t) => {
  const dir = fixture(t);
  const planned = JSON.parse(readFileSync(join(repo, 'test/delegated/k10/connect-three-state-evidence.json'), 'utf8'));
  assert.equal(planned.evidenceKind, 'PLANNED_BROWSER_SCREENSHOTS_NOT_CAPTURED');
  assert.deepEqual(planned.screenshots.map((s) => s.state), ['loading', 'error', 'success']);
  const html = readFileSync(join(repo, 'web/connect.html'), 'utf8');
  for (const state of planned.screenshots) {
    assert.ok(html.includes(`id="${state.anchor}"`));
    assert.equal(state.status, 'NOT_RUN');
    assert.equal(state.file, null);
  }
  const report = evaluateConnectEvidence(planned, dir);
  assert.equal(report.artifactStatus, 'NOT_RUN');
  assert.equal(report.sourceProvenance, 'MISSING');
});

test('#539: a source JSON claiming PASS cannot override missing or malformed evidence', (t) => {
  const dir = fixture(t);
  const report = evaluateConnectEvidence({ sourceSha: sha, status: 'PASS', screenshots: [
    { state: 'loading', file: '../secret.png', width: 375, height: 812, sha256: '0'.repeat(64) },
    { state: 'error', file: 'bad.png', width: 375, height: 812, sha256: '0'.repeat(64) },
    { state: 'success', file: 'bad.png', width: 375, height: 812, sha256: '0'.repeat(64) },
  ] }, dir);
  assert.notEqual(report.artifactStatus, 'PASS');
  assert.equal(report.artifactStatus, 'FAIL');
  assert.ok(report.cases.every((c) => c.status !== 'ARTIFACT_VALID'));
});

test('#485: corrupt PNG never verifies even with a matching SHA-256 hash', (t) => {
  const dir = fixture(t);
  const data = Buffer.from('not-a-png');
  writeFileSync(join(dir, 'error.png'), data);
  const digest = createHash('sha256').update(data).digest('hex');
  const report = evaluateConnectEvidence({ sourceSha: sha, screenshots: [
    { state: 'error', file: 'error.png', width: 375, height: 812, sha256: digest },
  ] }, dir);
  assert.equal(report.artifactStatus, 'FAIL');
  assert.equal(report.cases.find((c) => c.state === 'error').status, 'FAIL');
});

test('#485: valid synthetic PNG bytes verify as artifacts but never as live pairing', (t) => {
  const dir = fixture(t);
  const screenshots = ['loading', 'error', 'success'].map((state, index) => {
    const bytes = tinySyntheticPng(index);
    const hash = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(dir, `${state}.png`), bytes);
    return { state, file: `${state}.png`, width: 1, height: 1, sha256: hash };
  });
  const report = evaluateConnectEvidence({ sourceSha: sha, screenshots }, dir);
  assert.equal(report.artifactStatus, 'ARTIFACTS_VERIFIED_ORIGIN_UNPROVEN');
  assert.ok(report.cases.every((c) => c.status === 'ARTIFACT_VALID'));
  assert.equal(report.realBrowserProvenance, 'NOT_VERIFIED');
  assert.equal(report.realUserPairing, 'NOT_RUN');
  assert.equal(report.windowsAcceptance, 'NOT_RUN');
});

test('#485: identical screenshot bytes cannot substantiate three distinct UI states', (t) => {
  const dir = fixture(t);
  const bytes = tinySyntheticPng();
  const hash = createHash('sha256').update(bytes).digest('hex');
  const screenshots = ['loading', 'error', 'success'].map((state) => {
    writeFileSync(join(dir, `${state}.png`), bytes);
    return { state, file: `${state}.png`, width: 1, height: 1, sha256: hash };
  });
  const report = evaluateConnectEvidence({ sourceSha: sha, screenshots }, dir);
  assert.equal(report.artifactStatus, 'FAIL');
  assert.ok(report.cases.some((c) => c.reason === 'duplicate screenshot content'));
});

test('#812: local grant false with separately witnessed input may not be labeled globally disabled', () => {
  const report = auditConsoleIndicator({ localGrantActive: false, effectiveControlVerified: 'yes', displayClaimsDisabled: true });
  assert.equal(report.status, 'CONTRADICTION');
  assert.equal(report.effectiveAuthorization, 'WITNESSED_SEPARATELY_FROM_LOCAL_GRANT');
});

test('#812: neither local grant nor an unknown effective authorization proves input works', () => {
  assert.equal(auditConsoleIndicator({ localGrantActive: false, effectiveControlVerified: 'unknown', displayClaimsDisabled: false }).effectiveAuthorization, 'UNKNOWN');
  assert.equal(auditConsoleIndicator({ localGrantActive: true, effectiveControlVerified: 'no', displayClaimsDisabled: false }).status, 'SOURCE_CONTRACT_ONLY');
  assert.equal(auditConsoleIndicator({ localGrantActive: null, effectiveControlVerified: 'unknown', displayClaimsDisabled: false }).status, 'INSUFFICIENT_EVIDENCE');
});
