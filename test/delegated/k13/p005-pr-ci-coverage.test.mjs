import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { evaluatePrTestCoverage } from '../../../scripts/delegated/k13/p005-pr-ci-coverage.mjs';

const sha = 'a'.repeat(40);
const source = 'run: node --test test/delegated/k20/*.test.mjs';
const jobs = ['test (22)', 'test (24)', 'browser-live'].map(name => ({
  name, run_id: 10, status: 'completed', conclusion: 'success',
}));
const sample = () => ({
  pr: { number: 42, head: { sha }, state: 'open', merged: false },
  run: { id: 10, head_sha: sha, name: 'CI', event: 'pull_request', status: 'completed', conclusion: 'success' },
  jobs, totalJobs: 3, changedTests: ['test/delegated/k13/new-evidence.test.mjs'],
  ciSource: source, npmTestCommand: 'node --test --import tsx test/**/*.test.ts',
});

test('a 3/3 green PR workflow does not prove omitted nested test execution', () => {
  const result = evaluatePrTestCoverage(sample());
  assert.equal(result.source_ci, 'PASS');
  assert.equal(result.submitted_test_execution, 'NOT_PROVEN');
  assert.deepEqual(result.missing_ci_source_paths, ['test/delegated/k13/new-evidence.test.mjs']);
  assert.equal(result.physical_device, 'NOT_RUN');
});

test('an explicit source path still requires hosted test-output proof', () => {
  const candidate = sample();
  candidate.ciSource += '\nrun: node --test test/delegated/k13/new-evidence.test.mjs';
  const result = evaluatePrTestCoverage(candidate);
  assert.equal(result.source_ci, 'PASS');
  assert.equal(result.submitted_test_execution, 'SOURCE_REFERENCE_ONLY');
});

test('main push green does not substitute for PR event even on the same SHA', () => {
  const candidate = sample();
  candidate.run.event = 'push';
  assert.equal(evaluatePrTestCoverage(candidate).source_reason, 'WRONG_WORKFLOW_EVENT');
});

test('PR head advanced after CI run blocks stale green evidence', () => {
  const candidate = sample();
  candidate.pr.head.sha = 'b'.repeat(40);
  assert.equal(evaluatePrTestCoverage(candidate).source_reason, 'RUN_HEAD_MISMATCH');
});

test('zero, truncated, cross-run and skipped job evidence cannot pass', () => {
  const zero = sample();
  zero.jobs = []; zero.totalJobs = 0;
  assert.equal(evaluatePrTestCoverage(zero).source_reason, 'ZERO_OR_INCOMPLETE_JOB_PAGE');
  const partial = sample();
  partial.totalJobs = 4;
  assert.equal(evaluatePrTestCoverage(partial).source_reason, 'ZERO_OR_INCOMPLETE_JOB_PAGE');
  const unbound = sample();
  unbound.jobs = jobs.map(({ run_id, ...rest }) => rest);
  assert.equal(evaluatePrTestCoverage(unbound).source_reason, 'FAILED_OR_UNBOUND_JOB');
  const skipped = sample();
  skipped.jobs = jobs.map(j => j.name === 'browser-live' ? { ...j, conclusion: 'skipped' } : j);
  assert.equal(evaluatePrTestCoverage(skipped).source_reason, 'FAILED_OR_UNBOUND_JOB');
});

test('missing Windows or Node matrix and closed-unmerged PR are separate blockers', () => {
  const missingWindows = sample();
  missingWindows.jobs = jobs.slice(0, 2); missingWindows.totalJobs = 2;
  assert.equal(evaluatePrTestCoverage(missingWindows).source_reason, 'MISSING_NODE_OR_WINDOWS_JOB');
  const closed = sample();
  closed.pr.state = 'closed';
  assert.equal(evaluatePrTestCoverage(closed).source_reason, 'NOT_OPEN_UNMERGED_PR');
});

test('three recorded 7/7 green PRs still have uninvoked submitted tests', () => {
  const cases = JSON.parse(readFileSync(new URL('./p005-pr-ci-candidates.fixture.json', import.meta.url), 'utf8'));
  const ciSource = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.deepEqual(cases.map(item => item.pr.number), [1111, 1124, 1112]);
  const outcomes = cases.map(item => evaluatePrTestCoverage({
    ...item, ciSource, npmTestCommand: 'node --test --import tsx test/**/*.test.ts',
  }));
  assert.ok(outcomes.every(o => o.source_ci === 'PASS'));
  assert.ok(outcomes.every(o => o.submitted_test_execution === 'NOT_PROVEN'));
  assert.deepEqual(outcomes.map(o => o.missing_ci_source_paths.length), [1, 1, 2]);
});
