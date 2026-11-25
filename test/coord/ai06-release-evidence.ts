/** AI-06: offline release-evidence classifier. Snapshot checks are not signed release approval. */
export type Verdict = 'PASS' | 'FAIL' | 'SKIP' | 'NOT_RUN' | 'RUNNING';
export type Proof = { status: Verdict; sha?: string; evidence?: string };
export type WorkflowJob = { name: string; status?: string | null; conclusion?: string | null; run_id?: number; head_sha?: string };
export type WorkflowRun = {
  id: number; name: string; head_sha: string; status: string; conclusion: string | null;
  run_attempt: number; event: string; jobs: WorkflowJob[];
};
export type ReleaseSnapshot = {
  expectedHeadSha: string;
  workflows: WorkflowRun[];
  checks: Record<string, Proof>;
};
export const REQUIRED_WORKFLOWS: Readonly<Record<string, readonly string[]>> = {
  'CI': ['test (22)', 'test (24)', 'browser-live', 'linux-native-live',
    'wsl2-live', 'security-operational-live',
    'connection-v2-negative-windows (22)', 'connection-v2-negative-windows (24)'],
  'Release Readiness': ['package (ubuntu-latest)', 'package (windows-latest)', 'package (macos-latest)'],
  'Connection v2 Relay QA': ['relay-qa (windows-latest, Node 22)', 'relay-qa (ubuntu-latest, Node 22)',
    'relay-qa (windows-latest, Node 24)', 'relay-qa (ubuntu-latest, Node 24)'],
  'AI-04 Windows Atomic No-Replay': ['atomic-windows (22)', 'atomic-windows (24)'],
};
export const REQUIRED_CHECKS = [
  'typecheck', 'build', 'source_preservation_79', 'source_preservation_243',
  'system_hub_boot', 'prelogin_agent', 'core_broker_elevated',
  'sqlite_restart', 'sqlite_power_loss', 'connection_local_first',
  'cloudflare_external_reconnect', 'windows_vm_reboot',
  'official_upgrade_rollback', 'signed_windows_rollout',
] as const;
const SHA = /^[0-9a-f]{40}$/;
export const statusOf = (state?: string | null, conclusion?: string | null): Verdict => {
  if (!state || state === 'pending') return 'NOT_RUN';
  if (['queued', 'waiting', 'requested', 'in_progress'].includes(state)) return 'RUNNING';
  if (state !== 'completed') return 'FAIL';
  if (conclusion === 'success') return 'PASS';
  if (conclusion === 'skipped') return 'SKIP';
  return 'FAIL';
};
export type ReleaseAssessment = {
  recommendation: 'NO_GO' | 'READY_FOR_MANUAL_SIGNOFF';
  findings: string[];
  workflowStatus: Record<string, Verdict>;
  checkStatus: Record<string, Verdict>;
  snapshotOnly: true;
};
/** Requires original job->run->SHA links; does not trust a caller's blanket "passed" flag. */
export function assessReleaseEvidence(snapshot: ReleaseSnapshot): ReleaseAssessment {
  const findings: string[] = [];
  const workflowStatus: Record<string, Verdict> = {};
  const checkStatus: Record<string, Verdict> = {};
  const expected = snapshot?.expectedHeadSha;
  if (!SHA.test(expected ?? '')) findings.push('INVALID_EXPECTED_SHA');
  const runs = Array.isArray(snapshot?.workflows) ? snapshot.workflows : [];
  const checks = snapshot?.checks ?? {};
  for (const [workflow, mandatoryJobs] of Object.entries(REQUIRED_WORKFLOWS)) {
    const found = runs.filter(run => run?.name === workflow);
    if (found.length !== 1) {
      findings.push(found.length ? 'DUPLICATE_WORKFLOW:' + workflow : 'MISSING_WORKFLOW:' + workflow);
      workflowStatus[workflow] = 'NOT_RUN';
      continue;
    }
    const run = found[0]!;
    const state = statusOf(run.status, run.conclusion);
    workflowStatus[workflow] = state;
    if (state !== 'PASS') findings.push('WORKFLOW_' + state + ':' + workflow);
    if (!SHA.test(run.head_sha ?? '') || run.head_sha !== expected)
      findings.push('WORKFLOW_SHA_MISMATCH:' + workflow);
    if (!Number.isSafeInteger(run.id) || run.id <= 0 || !Number.isSafeInteger(run.run_attempt)
      || run.run_attempt < 1 || !['pull_request', 'workflow_dispatch', 'push'].includes(run.event))
      findings.push('WORKFLOW_IDENTITY_INVALID:' + workflow);
    const jobs = Array.isArray(run.jobs) ? run.jobs : [];
    const usedNames = new Set<string>();
    for (const job of jobs) {
      if (usedNames.has(job.name)) findings.push('DUPLICATE_JOB:' + workflow + ':' + job.name);
      usedNames.add(job.name);
      if (job.run_id !== run.id || job.head_sha !== run.head_sha)
        findings.push('JOB_PROVENANCE_MISMATCH:' + workflow + ':' + job.name);
    }
    for (const jobName of mandatoryJobs) {
      const job = jobs.find(j => j.name === jobName);
      const jobStatus = statusOf(job?.status, job?.conclusion);
      if (jobStatus !== 'PASS') findings.push('REQUIRED_JOB_' + jobStatus + ':' + workflow + ':' + jobName);
    }
  }
  for (const name of REQUIRED_CHECKS) {
    const proof = checks[name];
    const state = proof?.status ?? 'NOT_RUN';
    checkStatus[name] = state;
    if (!['PASS', 'FAIL', 'SKIP', 'NOT_RUN', 'RUNNING'].includes(state)) {
      findings.push('INVALID_CHECK_STATE:' + name);
    } else if (state !== 'PASS') {
      findings.push('CHECK_' + state + ':' + name);
    }
    if (state === 'PASS' &&
      (proof?.sha !== expected || !SHA.test(proof.sha ?? '')
       || !proof.evidence || proof.evidence.trim().length < 12)) {
      findings.push('CHECK_PROVENANCE_MISSING:' + name);
    }
  }
  // This classifier consumes caller-supplied snapshots. Even a complete set must be
  // independently verified and explicitly approved before a production GO decision.
  return {recommendation: findings.length ? 'NO_GO' : 'READY_FOR_MANUAL_SIGNOFF',
    findings, workflowStatus, checkStatus, snapshotOnly: true};
}
