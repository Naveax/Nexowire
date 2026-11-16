import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (name) => readFileSync(path.join(root, name), 'utf8');
const browserSuite = read('test/browser-live.test.ts');
const workflow = read('.github/workflows/ci.yml');
const connectPage = read('web/connect.html');

// A generic browser-live success is real evidence for the exact fixture it
// ran, but it is not proof of a different page, screenshot or OAuth journey.
function classifyConnectAcceptance(evidence) {
  if (evidence.ciConclusion !== 'success') return 'CI_NOT_GREEN';
  if (evidence.executedSuite !== 'test/browser-live.test.ts') return 'UNRELATED_SUITE';
  if (evidence.pageKind !== 'nexowire-connect' ||
      !/^https:\/\/[^/?#]+\/connect\.html(?:[?#]|$)/.test(evidence.pageUrl ?? '')) {
    return 'CONNECT_PAGE_NOT_RUN';
  }
  if (!/^[a-f0-9]{64}$/.test(evidence.screenshotSha256 ?? '') ||
      evidence.screenshotArtifact !== 'connect-page-capture') {
    return 'CONNECT_SCREENSHOT_NOT_PROVEN';
  }
  if (evidence.oauthProof !== 'device-bound-live-observed') return 'OAUTH_NOT_RUN';
  return 'CONNECT_JOURNEY_EVIDENCED';
}

test('P006 HAVUZ T-667 #1006: hosted browser-live runs a real Edge browser, but on a local fixture', () => {
  assert.match(workflow, /node --test --import tsx test\/browser-live\.test\.ts/);
  assert.match(browserSuite, /'native browser manager drives a real local Edge page end-to-end'/);
  assert.match(browserSuite, /browser: 'edge'/);
  assert.match(browserSuite, /const server = createServer/);
  assert.match(browserSuite, /server\.listen\(0, '127\.0\.0\.1'/);
  assert.match(browserSuite, /'<button id="go"/);
  assert.match(browserSuite, /manager\.visualVerify/);
  assert.match(browserSuite, /manager\.screenshot/);
  assert.match(browserSuite, /assert\.ok\(screenshot\.bytes > 100\)/);
  assert.doesNotMatch(browserSuite, /connect\.html|oauth|pairing/i,
    'Suite now exercises the product connect flow; evidence assessment must be updated');
  assert.match(connectPage, /BAĞLA/);
});

test('P006 HAVUZ T-667: green CI plus real fixture screenshot must fail closed for connect onboarding', () => {
  const evidence = {
    ciConclusion: 'success',
    executedSuite: 'test/browser-live.test.ts',
    pageKind: 'loopback-fixture',
    pageUrl: 'http://127.0.0.1:41234/',
    screenshotSha256: 'a'.repeat(64),
    screenshotArtifact: 'edge-fixture',
    oauthProof: 'not-run',
  };
  assert.equal(classifyConnectAcceptance(evidence), 'CONNECT_PAGE_NOT_RUN');
  assert.equal(classifyConnectAcceptance({ ...evidence, ciConclusion: 'failure' }), 'CI_NOT_GREEN');
  assert.equal(classifyConnectAcceptance({ ...evidence, executedSuite: 'test/something-else.ts' }), 'UNRELATED_SUITE');
});

test('P006 HAVUZ T-667: even matching page URL cannot stand in for screenshot or OAuth evidence', () => {
  const page = {
    ciConclusion: 'success', executedSuite: 'test/browser-live.test.ts',
    pageKind: 'nexowire-connect', pageUrl: 'https://example.invalid/connect.html',
    screenshotSha256: '', screenshotArtifact: null, oauthProof: 'not-run',
  };
  assert.equal(classifyConnectAcceptance(page), 'CONNECT_SCREENSHOT_NOT_PROVEN');
  assert.equal(classifyConnectAcceptance({ ...page, screenshotSha256: 'a'.repeat(64), screenshotArtifact: 'connect-page-capture' }), 'OAUTH_NOT_RUN');
  // This is a *synthetic gate contract*, not an actual product acceptance run.
  assert.equal(classifyConnectAcceptance({ ...page, screenshotSha256: 'a'.repeat(64), screenshotArtifact: 'connect-page-capture', oauthProof: 'device-bound-live-observed' }), 'CONNECT_JOURNEY_EVIDENCED');
});
