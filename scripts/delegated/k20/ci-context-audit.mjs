/** Offline reconciliation of raw GitHub Actions run/job API snapshots. No writes or reruns. */
const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
const id = value => Number.isSafeInteger(value) && value > 0;

export function auditCiContext({ pr, run, jobsPage }) {
  if (!id(pr?.number) || !sha(pr?.head?.sha) || !id(run?.id) ||
      !id(run?.run_attempt) || !Array.isArray(jobsPage?.jobs) ||
      !Number.isSafeInteger(jobsPage.total_count) || jobsPage.total_count < 0) {
    throw new TypeError('Expected raw GitHub PR, workflow run and paginated job snapshot');
  }
  const reasons = [];
  const check = (condition, reason) => { if (!condition) reasons.push(reason); };
  check(run.head_sha === pr.head.sha, 'RUN_HEAD_NOT_PR_HEAD');
  check(run.event === 'pull_request', 'RUN_EVENT_NOT_PR');
  check(run.status === 'completed', 'RUN_NOT_COMPLETED');
  check(run.conclusion === 'success', `RUN_NOT_SUCCESS:${run.conclusion ?? 'null'}`);
  check(jobsPage.total_count > 0, 'NO_GITHUB_JOBS');
  check(jobsPage.total_count === jobsPage.jobs.length, 'INCOMPLETE_JOB_PAGINATION');
  const jobIds = new Set();
  for (const job of jobsPage.jobs) {
    if (!id(job?.id) || jobIds.has(job.id)) throw new TypeError('Missing/duplicate job ID');
    jobIds.add(job.id);
    check(job.run_id === run.id, `FOREIGN_RUN_JOB:${job.id}`);
    check(job.run_attempt === run.run_attempt, `FOREIGN_ATTEMPT_JOB:${job.id}`);
    check(job.head_sha === pr.head.sha, `STALE_HEAD_JOB:${job.id}`);
    check(job.status === 'completed' && job.conclusion === 'success',
      `JOB_NOT_SUCCESS:${job.id}:${job.status}/${job.conclusion}`);
  }
  return { prNumber: pr.number, expectedHead: pr.head.sha, runId: run.id,
    runAttempt: run.run_attempt, jobsReturned: jobsPage.jobs.length,
    jobsReported: jobsPage.total_count,
    verdict: reasons.length ? 'NO_GO' : 'REPORTED_GREEN_UNVERIFIED', reasons };
}

/** Detects an exact TAP assertion-count pin that can fail although every test passed. */
export function auditFixedTapCount(workflowText, reported, tapFile = 'nw-k20-qa.tap') {
  if (typeof workflowText !== 'string' ||
      typeof tapFile !== 'string' || !/^[a-z\d-]+\.tap$/i.test(tapFile) ||
      !Number.isSafeInteger(reported?.tests) || reported.tests < 0 ||
      !Number.isSafeInteger(reported?.passed) || reported.passed < 0 ||
      !Number.isSafeInteger(reported?.failed) || reported.failed < 0) {
    throw new TypeError('Expected workflow source and TAP summary counts');
  }
  const lines = workflowText.split('\n').filter(x => x.includes(tapFile));
  const tests = lines.flatMap(x => [...x.matchAll(/grep\s+-qx\s+['"]# tests (\d+)['"]/g)]
    .map(y => Number(y[1])));
  const passed = lines.flatMap(x => [...x.matchAll(/grep\s+-qx\s+['"]# pass (\d+)['"]/g)]
    .map(y => Number(y[1])));
  if (!tests.length || !passed.length) return { verdict: 'NO_FIXED_COUNT_GATES_DETECTED' };
  return { expectedTests: tests, expectedPasses: passed,
    actualTests: reported.tests, actualPasses: reported.passed,
    verdict: tests.every(x => x === reported.tests) && passed.every(x => x === reported.passed)
      ? 'COUNT_MATCH' : 'FIXED_COUNT_MISMATCH',
    allAssertionsPassed: reported.tests === reported.passed && reported.failed === 0 };
}
