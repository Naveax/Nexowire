import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { auditHostedBrowserEvidence, inspectBrowserLiveTarget } from '../../../scripts/delegated/k10/hosted-browser-evidence-audit.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// Read the exact checked-out commit's source even in a sparse worktree.
const actualWorkflow = execFileSync('git', ['show', 'HEAD:.github/workflows/ci.yml'], { cwd: repo, encoding: 'utf8' });
const actualBrowserTest = execFileSync('git', ['show', 'HEAD:test/browser-live.test.ts'], { cwd: repo, encoding: 'utf8' });
const head = '0f3916ecd3d3ff0db5d7a1743b007e52a0cd16aa';
const older = 'ac9573a58a4ff17bc4f1ffcd31befccd4e17aede';
const successfulBrowserJob = [{ name: 'browser-live', status: 'completed', conclusion: 'success' }];

test('#485 T-449: successful browser-live does not run K10 three-state screenshot capture', () => {
  const result = auditHostedBrowserEvidence({ workflow: actualWorkflow, targetSha: head, runSha: head, jobs: successfulBrowserJob, browserTestSource: actualBrowserTest });
  assert.equal(result.checks.browserJobConfigured, true);
  assert.equal(result.checks.genericBrowserTestListed, true);
  assert.equal(result.checks.baselineOfflineTestListed, true);
  assert.equal(result.checks.issueNegativesListed, false);
  assert.equal(result.checks.pngContractListed, false);
  assert.equal(result.checks.staticVisualCaptureListed, false);
  assert.equal(result.checks.threeStateCaptureListed, false);
  assert.equal(result.status, 'NOT_RUN');
  assert.equal(result.reason, 'THREE_STATE_CAPTURE_NOT_IN_WORKFLOW');
  assert.equal(result.livePairing, 'NOT_RUN');
  assert.equal(result.browserTarget.target, 'EPHEMERAL_LOOPBACK_HTML_FIXTURE');
  assert.equal(result.browserTarget.screenshotAssertions, 'SOURCE_ASSERTIONS_PRESENT');
  assert.equal(result.browserTarget.pageDimensions, '800x600_SOURCE');
});

test('#539 T-589: browser-live opens its own 800x600 Edge fixture, not web/connect.html', () => {
  const report = inspectBrowserLiveTarget(actualBrowserTest);
  assert.equal(report.target, 'EPHEMERAL_LOOPBACK_HTML_FIXTURE');
  assert.equal(report.pageDimensions, '800x600_SOURCE');
  assert.equal(report.screenshotAssertions, 'SOURCE_ASSERTIONS_PRESENT');
  assert.match(actualBrowserTest, /manager\.start\(/);
  assert.match(actualBrowserTest, /browser:\s*'edge'/);
  assert.match(actualBrowserTest, /selector:\s*'#status'/);
  assert.doesNotMatch(actualBrowserTest, /web\/connect\.html/);
});

test('#539: screenshots of unknown or mixed targets never count as K10 onboarding visuals', () => {
  assert.equal(inspectBrowserLiveTarget('').target, 'UNINSPECTED');
  assert.equal(inspectBrowserLiveTarget('await manager.screenshot(); // web/connect.html').target, 'UNKNOWN_NOT_K10_PROVEN');
  assert.equal(inspectBrowserLiveTarget(actualBrowserTest.replace('initialUrl: url,', 'initialUrl: url, // web/connect.html'))
    .target, 'MIXED_TARGETS_REVIEW_REQUIRED');
});

test('#539 T-452: CI success from an older source commit is stale, not a browser PASS', () => {
  const result = auditHostedBrowserEvidence({ workflow: actualWorkflow, targetSha: head, runSha: older, jobs: successfulBrowserJob });
  assert.equal(result.status, 'FAIL_STALE_SHA');
  assert.equal(result.reason, 'STALE_RUN_SHA');
  assert.equal(result.realThreeStateScreenshots, 'NOT_VERIFIED');
});

test('#539 T-454: absence of hosted job result remains NOT_RUN despite source-level markup', () => {
  const result = auditHostedBrowserEvidence({ workflow: actualWorkflow, targetSha: head, runSha: head, jobs: [] });
  assert.equal(result.status, 'NOT_RUN');
  assert.equal(result.reason, 'BROWSER_JOB_NOT_SUCCESSFUL');
  assert.equal(result.checks.baselineOfflineTestListed, true);
  assert.equal(result.physicalWindows, 'NOT_RUN');
});

test('#485: a comment, step name, or echo containing capture path is not an executed capture', () => {
  const workflow = `jobs:\n  test:\n    steps:\n      - run: node --test test/sample.test.ts\n  browser-live:\n    steps:\n      - name: node scripts/delegated/k10/hosted-connect-three-state.mjs\n        # node scripts/delegated/k10/hosted-connect-three-state.mjs\n        run: echo scripts/delegated/k10/hosted-connect-three-state.mjs\n`;
  const result = auditHostedBrowserEvidence({ workflow, targetSha: head, runSha: head, jobs: successfulBrowserJob });
  assert.equal(result.checks.threeStateCaptureListed, false);
  assert.equal(result.status, 'NOT_RUN');
});

test('#485: even a wired runner with a green job cannot establish screenshot origin without artifacts', () => {
  const workflow = `jobs:\n  test:\n    steps:\n      - run: node --test test/delegated/k10/issue-evidence-contract.test.mjs\n  browser-live:\n    steps:\n      - run: node scripts/delegated/k10/hosted-connect-three-state.mjs --out temp\n`;
  const result = auditHostedBrowserEvidence({ workflow, targetSha: head, runSha: head, jobs: successfulBrowserJob });
  assert.equal(result.checks.pngContractListed, true);
  assert.equal(result.checks.threeStateCaptureListed, true);
  assert.equal(result.status, 'NOT_RUN');
  assert.equal(result.reason, 'CAPTURE_ARTIFACTS_NOT_PROVIDED');
});

test('#485 T-590: a synthetic fixture cannot claim real pairing or Windows acceptance', () => {
  const pretendSuccess = {
    evidenceKind: 'LOCAL_FILE_DOM_FIXTURE_NO_NETWORK',
    realPairing: 'PASS', windowsDeviceAcceptance: 'VERIFIED', screenshots: [{ state: 'success' }],
  };
  const report = auditHostedBrowserEvidence({ workflow: actualWorkflow, targetSha: head, runSha: head,
    jobs: successfulBrowserJob, captureManifest: pretendSuccess });
  assert.equal(report.status, 'FAIL_FALSE_LIVE_CLAIM');
  assert.equal(report.reason, 'SYNTHETIC_FIXTURE_CLAIMS_LIVE_ACCEPTANCE');
  assert.equal(report.captureEvidence.liveAcceptanceClaimRejected, true);
  const honest = auditHostedBrowserEvidence({ workflow: actualWorkflow, targetSha: head, runSha: head,
    jobs: successfulBrowserJob,
    captureManifest: { evidenceKind: 'LOCAL_FILE_DOM_FIXTURE_NO_NETWORK', realPairing: 'NOT_RUN' } });
  assert.equal(honest.status, 'NOT_RUN');
});

test('#1006 T-593: seven successful generic CI jobs still leave omitted K10 MJS suites NOT_RUN', () => {
  const names = ['test (22)', 'test (24)', 'security-operational-live', 'linux-native-live',
    'browser-live', 'wsl2-live', 'macos-agent-lifecycle-live'];
  const jobs = names.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
  const report = auditHostedBrowserEvidence({ workflow: actualWorkflow, targetSha: head, runSha: head,
    jobs, browserTestSource: actualBrowserTest });
  assert.equal(jobs.filter((job) => job.conclusion === 'success').length, 7);
  assert.equal(report.checks.issueNegativesListed, false);
  assert.equal(report.checks.pngContractListed, false);
  assert.equal(report.checks.threeStateCaptureListed, false);
  assert.equal(report.reason, 'THREE_STATE_CAPTURE_NOT_IN_WORKFLOW');
  assert.equal(report.status, 'NOT_RUN');
});

test('#485: missing expected SHA never promotes a browser job to PASS', () => {
  const result = auditHostedBrowserEvidence({ workflow: actualWorkflow, targetSha: null, runSha: head, jobs: successfulBrowserJob });
  assert.equal(result.status, 'NOT_RUN');
  assert.equal(result.reason, 'MISSING_EXACT_SHA');
});
