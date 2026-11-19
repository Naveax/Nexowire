import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditMainCiSource } from './p005-main-ci-inventory.mjs';

const requiredJobs = ['test (22)', 'test (24)', 'browser-live'];

export function evaluatePrTestCoverage({
  pr, run, jobs, totalJobs, changedTests, ciSource, npmTestCommand,
}) {
  const candidate = {
    pr: pr?.number ?? null,
    pr_head: pr?.head?.sha ?? null,
    run_id: run?.id ?? null,
    run_head: run?.head_sha ?? null,
    source_ci: 'NOT_PASS',
    source_reason: 'INCOMPLETE_EVIDENCE',
    submitted_test_execution: 'NOT_PROVEN',
    physical_device: 'NOT_RUN',
    release_acceptance: 'NOT_RUN',
    missing_ci_source_paths: [],
  };
  if (!/^[0-9a-f]{40}$/i.test(pr?.head?.sha ?? '')) return { ...candidate, source_reason: 'INVALID_PR_HEAD' };
  if (pr.state !== 'open' || pr.merged) return { ...candidate, source_reason: 'NOT_OPEN_UNMERGED_PR' };
  if (!run || run.head_sha !== pr.head.sha) return { ...candidate, source_reason: 'RUN_HEAD_MISMATCH' };
  // A main push may be green with the same source SHA; it is not a PR run.
  if (run.event !== 'pull_request' || run.name !== 'CI') {
    return { ...candidate, source_reason: 'WRONG_WORKFLOW_EVENT' };
  }
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    return { ...candidate, source_reason: 'RUN_NOT_SUCCESS' };
  }
  if (!Array.isArray(jobs) || jobs.length === 0 || totalJobs !== jobs.length) {
    return { ...candidate, source_reason: 'ZERO_OR_INCOMPLETE_JOB_PAGE' };
  }
  if (jobs.some(job => job.run_id !== run.id || job.status !== 'completed' || job.conclusion !== 'success')) {
    return { ...candidate, source_reason: 'FAILED_OR_UNBOUND_JOB' };
  }
  if (!requiredJobs.every(name => jobs.filter(job => job.name === name).length === 1)) {
    return { ...candidate, source_reason: 'MISSING_NODE_OR_WINDOWS_JOB' };
  }
  const paths = (changedTests ?? []).filter(path => /^test\/.*\.test\.(?:ts|mjs)$/.test(path));
  const coverage = auditMainCiSource({ ciSource, npmTestCommand, paths });
  const missing = coverage.no_known_invocation;
  return {
    ...candidate,
    source_ci: 'PASS',
    source_reason: 'EXACT_PR_SHA_JOBS_PASS',
    submitted_test_execution: paths.length === 0 ? 'NO_SUBMITTED_TESTS' :
      missing.length ? 'NOT_PROVEN' : 'SOURCE_REFERENCE_ONLY',
    missing_ci_source_paths: missing,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [snapshotPath, ciPath, packagePath] = process.argv.slice(2);
  if (!snapshotPath || !ciPath || !packagePath) {
    console.error('Usage: node p005-pr-ci-coverage.mjs SNAPSHOT.json CI.yml package.json');
    process.exitCode = 2;
  } else {
    const cases = JSON.parse(readFileSync(resolve(snapshotPath), 'utf8'));
    const ciSource = readFileSync(resolve(ciPath), 'utf8');
    const pkg = JSON.parse(readFileSync(resolve(packagePath), 'utf8'));
    const results = cases.map(item => evaluatePrTestCoverage({
      ...item, ciSource, npmTestCommand: pkg.scripts.test,
    }));
    console.log(JSON.stringify(results, null, 2));
    if (results.some(x => x.source_ci !== 'PASS' || x.submitted_test_execution === 'NOT_PROVEN')) {
      // A nonzero exit is an expected audit finding; not a CI test failure.
      process.exitCode = 1;
    }
  }
}
