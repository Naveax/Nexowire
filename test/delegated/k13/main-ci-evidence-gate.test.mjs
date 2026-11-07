import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { evaluateMainCI } from '../../../scripts/delegated/k13/main-ci-evidence-gate.mjs';

const sha = 'a'.repeat(40);
const oldSha = 'b'.repeat(40);
const run = (id, head_sha = sha, conclusion = 'success') => ({
  id, head_sha, status: 'completed', conclusion, name: 'CI',
});
const jobs = ['test (22)', 'test (24)', 'browser-live'].map(name => ({
  run_id: 9, name, status: 'completed', conclusion: 'success',
}));
const input = () => ({
  expectedHead: sha, runs: [run(9)], jobsByRun: { 9: jobs },
  totalJobsByRun: { 9: 3 }, requiredJobs: ['test (22)', 'test (24)', 'browser-live'],
});

test('one exact-head workflow with real jobs can prove hosted CI, not device or release', () => {
  const outcome = evaluateMainCI(input());
  assert.equal(outcome.source_ci, 'PASS');
  assert.equal(outcome.hosted_runner, 'PASS');
  assert.equal(outcome.physical_device, 'NOT_RUN');
  assert.equal(outcome.release_acceptance, 'NOT_RUN');
});

test('completed success with zero jobs and action_required are never PASS', () => {
  const empty = input();
  empty.jobsByRun = { 9: [] };
  empty.totalJobsByRun = { 9: 0 };
  assert.equal(evaluateMainCI(empty).reason, 'ZERO_JOB_RUN');
  const blocked = input();
  blocked.runs = [run(9, sha, 'action_required')];
  assert.equal(evaluateMainCI(blocked).source_ci, 'NOT_PASS');
});

test('old SHA, unfinished page and disjoint matrix never combine into PASS', () => {
  const old = input();
  old.runs = [run(9, oldSha)];
  assert.equal(evaluateMainCI(old).reason, 'NO_EXACT_HEAD_RUN');
  const page = input();
  page.totalJobsByRun = { 9: 4 };
  assert.equal(evaluateMainCI(page).reason, 'INCOMPLETE_JOB_PAGE');
  const unknownCount = input();
  unknownCount.totalJobsByRun = {};
  assert.equal(evaluateMainCI(unknownCount).reason, 'UNKNOWN_JOB_TOTAL');
  const mixed = input();
  mixed.jobsByRun = { 9: jobs.map((j, i) => ({ ...j, run_id: i ? 10 : 9 })) };
  assert.equal(evaluateMainCI(mixed).reason, 'JOB_FAILED_SKIPPED_OR_CROSS_RUN');
});

test('unrelated green workflow cannot masquerade as main CI', () => {
  const wrongWorkflow = input();
  wrongWorkflow.runs = [{ ...run(9), name: 'Release Readiness' }];
  assert.equal(evaluateMainCI(wrongWorkflow).reason, 'NO_EXACT_HEAD_RUN');
});

test('closed-unmerged PR and skipped Windows check are not accepted', () => {
  const closed = input();
  closed.pr = { state: 'closed', merged: false, draft: false };
  assert.equal(evaluateMainCI(closed).reason, 'CLOSED_UNMERGED_PR');
  const skipped = input();
  skipped.jobsByRun = { 9: jobs.map(j => j.name === 'browser-live'
    ? { ...j, conclusion: 'skipped' } : j) };
  assert.equal(evaluateMainCI(skipped).source_ci, 'NOT_PASS');
});
