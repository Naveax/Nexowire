import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { assessTap, classifyHostedEvidence, sourceInventory } from '../../../scripts/delegated/k13/p006-ci-gates.mjs';

const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const tap = count => `TAP version 13\n# tests ${count}\n# pass ${count}\n# fail 0\n# skipped 0\n# todo 0\n`;

test('55 source files can include seven not selected by main CI without claiming they were run', () => {
  const paths = [
    'test/delegated/k09/roadmap-evidence.test.mjs',
    'test/delegated/k11/p005-s5-evidence.test.ts',
    'test/delegated/k16/environment-doctor-contract.test.ts',
    'test/delegated/prototype-contract.test.ts',
    'test/delegated/k20/help-link-audit.test.mjs',
  ];
  const actual = sourceInventory(paths, 'run: node --test test/delegated/k20/*.test.mjs',
    'node --test --import tsx test/**/*.test.ts');
  assert.equal(actual.total, 5);
  assert.equal(actual.explicit, 1);
  assert.equal(actual.npmDirect, 1);
  assert.deepEqual(actual.missing, paths.filter(p => !p.includes('prototype-') && !p.includes('/k20/')));
  assert.equal(actual.evidence, 'SOURCE_ONLY_NOT_EXECUTION_PROOF');
});

test('a passing 50/50 K20 TAP is still rejected by a hardcoded 41 gate', () => {
  const outcome = assessTap(tap(50), 41);
  assert.equal(outcome.assertions, 'PASS');
  assert.equal(outcome.fixed_gate, 'FAIL_COUNT_MISMATCH');
  assert.equal(outcome.job_acceptance, 'NOT_PASS');
});

test('48/48 and 52/52 follow same fixed-41 failure; a genuine 41/41 qualifies', () => {
  for (const n of [48, 52]) {
    assert.equal(assessTap(tap(n), 41).job_acceptance, 'NOT_PASS');
  }
  assert.equal(assessTap(tap(41), 41).job_acceptance, 'PASS');
});

test('TAP missing a summary, skipped tests or failed assertions is NOT_PASS', () => {
  assert.equal(assessTap('# tests 41\n# pass 41\n').job_acceptance, 'NOT_PASS');
  assert.equal(assessTap(tap(41).replace('# skipped 0', '# skipped 1')).job_acceptance, 'NOT_PASS');
  assert.equal(assessTap(tap(41).replace('# fail 0', '# fail 1')).job_acceptance, 'NOT_PASS');
  assert.equal(assessTap(tap(0)).job_acceptance, 'NOT_PASS');
});

const proof = () => ({
  prHead: sha, runHead: sha, checkoutHead: sha, runEvent: 'pull_request',
  required: true, runId: 17, workflowName: 'CI', runStatus: 'completed', runConclusion: 'success',
  totalJobs: 3, jobs: ['test (22)', 'test (24)', 'browser-live'].map(name => ({
    name, run_id: 17, status: 'completed', conclusion: 'success',
  })),
  selectedFiles: ['test/delegated/k11/p005-s5-evidence.test.ts'],
  observedFiles: ['test/delegated/k11/p005-s5-evidence.test.ts'],
});

test('actual selected test path plus matching PR run HEAD supports hosted execution, not physical', () => {
  const result = classifyHostedEvidence(proof());
  assert.equal(result.required_pr_ci, 'PASS');
  assert.equal(result.selected_test_execution, 'HOSTED_EXECUTED');
  assert.equal(result.physical_device, 'NOT_RUN');
});

test('green jobs without direct evidence that nested tests ran cannot certify them', () => {
  const missing = proof(); missing.observedFiles = [];
  const verdict = classifyHostedEvidence(missing);
  assert.equal(verdict.selected_test_execution, 'NOT_PROVEN');
  assert.equal(verdict.required_pr_ci, 'NOT_PROVEN');
});

test('pinned auxiliary checkout of a PR head never becomes PR required CI', () => {
  const aux = proof(); aux.runHead = otherSha; aux.runEvent = 'push'; aux.required = false;
  const verdict = classifyHostedEvidence(aux);
  assert.equal(verdict.selected_test_execution, 'AUXILIARY_ONLY');
  assert.equal(verdict.required_pr_ci, 'NOT_PROVEN');
});

test('pinned source is stale when PR head advanced, even with green jobs', () => {
  const stale = proof(); stale.checkoutHead = otherSha;
  assert.equal(classifyHostedEvidence(stale).reason, 'SOURCE_SHA_MISMATCH');
  const old = proof(); old.prHead = otherSha;
  assert.equal(classifyHostedEvidence(old).reason, 'SOURCE_SHA_MISMATCH');
});

test('different main push run, failed jobs and missing test selection stay separate blockers', () => {
  const push = proof(); push.runEvent = 'push';
  assert.equal(classifyHostedEvidence(push).required_pr_ci, 'NOT_PROVEN');
  const failed = proof(); failed.jobs[0].conclusion = 'failure';
  assert.equal(classifyHostedEvidence(failed).reason, 'JOB_NOT_SUCCESS');
  const empty = proof(); empty.selectedFiles = [];
  assert.equal(classifyHostedEvidence(empty).reason, 'SELECTED_TEST_EXECUTION_UNVERIFIED');
});

test('unrelated green workflow, omitted job list and cross-run jobs cannot prove PR acceptance', () => {
  const wrong = proof(); wrong.workflowName = 'Release Readiness';
  assert.equal(classifyHostedEvidence(wrong).required_pr_ci, 'NOT_PROVEN');
  const emptyJobs = proof(); emptyJobs.jobs = []; emptyJobs.totalJobs = 0;
  assert.equal(classifyHostedEvidence(emptyJobs).reason, 'JOB_NOT_SUCCESS');
  const borrowed = proof(); borrowed.jobs[0].run_id = 18;
  assert.equal(classifyHostedEvidence(borrowed).reason, 'JOB_NOT_SUCCESS');
});

test('fork CI workflow stays read-only and explicitly selects all seven omitted main-CI tests', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/delegated-noncore.yml', import.meta.url), 'utf8');
  assert.match(workflow, /branches: \["k13\/p006-ci-gap-seven"\]/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node-version: \[22, 24\]/);
  assert.match(workflow, /git rev-parse HEAD.*GITHUB_SHA/);
  for (const name of [
    'k09/roadmap-evidence.test.mjs',
    'k11/issue-487-commercial-unknown.test.ts',
    'k11/issue-487-meter-acceptance.test.ts',
    'k11/p005-s5-evidence.test.ts',
    'k16/environment-doctor-contract.test.ts',
    'pool-k17/markdown-anchors.test.ts',
    'pool-k19/audit-physical-pass-labels.test.ts',
  ]) assert.ok(workflow.includes('test/delegated/' + name), `missing explicit test ${name}`);
  assert.doesNotMatch(workflow, /pull_request_target|secrets\.|contents: write|id-token: write/);
});
