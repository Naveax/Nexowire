import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function evaluateMainCI({
  expectedHead, runs, jobsByRun, totalJobsByRun = {},
  requiredJobs = ['test (22)', 'test (24)', 'browser-live'], workflowName = 'CI', pr = null,
}) {
  if (!/^[a-f0-9]{40}$/i.test(expectedHead ?? '')) {
    return { source_ci: 'NOT_PASS', reason: 'INVALID_HEAD' };
  }
  const candidates = runs.filter(run => run.head_sha === expectedHead && run.name === workflowName)
    .sort((a, b) => b.id - a.id);
  const run = candidates[0];
  const result = {
    exact_head: expectedHead,
    run_id: run?.id ?? null,
    source_ci: 'NOT_PASS',
    reason: 'NO_EXACT_HEAD_RUN',
    hosted_runner: 'NOT_PROVEN',
    physical_device: 'NOT_RUN',
    release_acceptance: 'NOT_RUN',
    pr_disposition: !pr ? 'NOT_ASSESSED' :
      pr.state === 'closed' && !pr.merged ? 'CLOSED_UNMERGED' :
      pr.merged ? 'MERGED_NOT_DEVICE_ACCEPTED' :
      pr.draft ? 'DRAFT_REVIEW_REQUIRED' : 'OPEN_REVIEW_REQUIRED',
  };
  if (!run) return result;
  // A valid run for the caller's SHA is stale if the PR advanced since it ran.
  if (pr?.head?.sha && pr.head.sha !== expectedHead) {
    return { ...result, reason: 'PR_HEAD_MISMATCH' };
  }
  if (pr?.state === 'closed' && !pr.merged) {
    return { ...result, reason: 'CLOSED_UNMERGED_PR' };
  }
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    return { ...result, reason: 'RUN_NOT_SUCCESS' };
  }
  const jobs = jobsByRun[run.id] ?? [];
  const totalJobs = totalJobsByRun[run.id];
  if (totalJobs === undefined) return { ...result, reason: 'UNKNOWN_JOB_TOTAL' };
  if (!jobs.length || totalJobs !== jobs.length) {
    return { ...result, reason: jobs.length ? 'INCOMPLETE_JOB_PAGE' : 'ZERO_JOB_RUN' };
  }
  if (jobs.some(job => job.run_id !== run.id ||
    job.status !== 'completed' || job.conclusion !== 'success')) {
    return { ...result, reason: 'JOB_FAILED_SKIPPED_OR_CROSS_RUN' };
  }
  if (!Array.isArray(requiredJobs) || requiredJobs.length === 0 ||
    requiredJobs.some(name => typeof name !== 'string' || !name.trim())) {
    return { ...result, reason: 'NO_REQUIRED_JOBS' };
  }
  const names = jobs.map(job => job.name);
  if (!requiredJobs.every(name => names.filter(actual => actual === name).length === 1)) {
    return { ...result, reason: 'MISSING_OR_DUPLICATE_MATRIX_JOB' };
  }
  return { ...result, source_ci: 'PASS', reason: 'EXACT_HEAD_JOB_PROOF', hosted_runner: 'PASS' };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node scripts/delegated/k13/main-ci-evidence-gate.mjs INPUT_JSON');
    process.exitCode = 2;
  } else {
    const input = JSON.parse(readFileSync(resolve(inputPath), 'utf8'));
    const outcome = evaluateMainCI(input);
    console.log(JSON.stringify(outcome, null, 2));
    if (outcome.source_ci !== 'PASS') process.exitCode = 1;
  }
}
