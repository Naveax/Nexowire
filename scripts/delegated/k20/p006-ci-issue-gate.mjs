#!/usr/bin/env node
/** Offline review of exact-HEAD CI, TAP counts, issue auto-close and device proof.
 * Inputs are untrusted snapshots: an offline green verdict is never GitHub approval.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SHA = /^[a-f\d]{40}$/i;
const exact = value => typeof value === 'string' && SHA.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;

export function auditFixedCountGate({ workflow, tap, expectedFile, head, runHead, runId, conclusion }) {
  if (typeof workflow !== 'string' || typeof tap !== 'string' ||
      typeof expectedFile !== 'string' || !/^[\w.-]+\.tap$/.test(expectedFile) ||
      !exact(head) || !exact(runHead) || !positive(runId)) {
    throw new TypeError('Workflow, TAP, exact PR/run HEAD and positive run ID required');
  }
  const commandLines = workflow.split('\n').filter(line => line.includes(expectedFile));
  const pinned = Object.fromEntries(['tests', 'pass', 'fail', 'skipped', 'todo'].map(key => {
    const matches = commandLines.flatMap(line =>
      [...line.matchAll(new RegExp(`grep\\s+-qx\\s+['"]# ${key} (\\d+)['"]`, 'g'))]
        .map(x => Number(x[1])));
    return [key, matches];
  }));
  const normalized = tap.replace(/^\d{4}-\d{2}-\d{2}T[^\s]+\s+/gm, '');
  const summary = Object.fromEntries(Object.keys(pinned).map(key => {
    const values = [...normalized.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))].map(x => Number(x[1]));
    return [key, values.length === 1 ? values[0] : null];
  }));
  const complete = Object.values(summary).every(value => value !== null);
  const assertionsGreen = complete && summary.tests > 0 && summary.tests === summary.pass &&
    summary.fail === 0 && summary.skipped === 0 && summary.todo === 0;
  const countDrift = assertionsGreen && pinned.tests.length === 1 && pinned.pass.length === 1 &&
    (pinned.tests[0] !== summary.tests || pinned.pass[0] !== summary.pass);
  const verdict = head !== runHead ? 'STALE_HEAD' : !complete ? 'UNKNOWN_TAP' :
    !assertionsGreen ? 'ASSERTIONS_RED' : countDrift && conclusion === 'failure' ?
      'COUNT_DRIFT_REPRODUCED' : countDrift ? 'COUNT_DRIFT_SUSPECTED' : 'NO_COUNT_DRIFT_PROVEN';
  return { head, runId, verdict, assertionsGreen, pinned, summary,
    ownerSourceNeedsReview: countDrift, accepted: false };
}

/** GitHub parses closing keywords even in negated prose such as "cannot close #487". */
export function findClosingKeywords(text) {
  if (typeof text !== 'string') throw new TypeError('PR description required');
  return [...text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)]
    .map(match => ({ issue: Number(match[1]), phrase: match[0] }));
}

export function auditIssueLifecycle({ issue, pr, transitions = [] }) {
  if (!positive(issue?.number) || !['open', 'closed'].includes(issue.state) ||
      !positive(pr?.number) || typeof pr.body !== 'string' || !Array.isArray(transitions) ||
      transitions.some(x => !['opened', 'closed', 'reopened'].includes(x))) {
    throw new TypeError('Issue state, PR body and valid event sequence required');
  }
  const closingKeywords = findClosingKeywords(`${pr.title || ''}\n${pr.body}`)
    .filter(x => x.issue === issue.number);
  const closedThenReopened = transitions.lastIndexOf('reopened') > transitions.lastIndexOf('closed') &&
    transitions.includes('closed');
  return { issue: issue.number, state: issue.state.toUpperCase(), pr: pr.number,
    prMerged: Boolean(pr.merged), closedThenReopened,
    closingKeywords, risk: closingKeywords.length ? 'AUTO_CLOSE_MARKER_PRESENT' : 'NO_MARKER_DETECTED',
    resolved: false, accepted: false,
    reason: issue.state === 'open' ? 'ISSUE_OPEN' : 'ISSUE_CLOSED_NOT_ACCEPTANCE' };
}

/** No conclusions may be borrowed from another PR SHA, job, runner or physical machine. */
export function auditHostedAcceptance({ head, run, jobs = [], newTests = [], physical = null }) {
  if (!exact(head) || !Array.isArray(jobs) || !Array.isArray(newTests) ||
      newTests.some(x => !x || typeof x.path !== 'string' || typeof x.marker !== 'string' ||
        !x.path.startsWith('test/') || !x.marker.trim())) {
    throw new TypeError('Exact PR HEAD and test path/marker declarations required');
  }
  const runCurrent = Boolean(run && exact(run.headSha) && run.headSha === head && positive(run.id));
  const jobIds = jobs.map(x => x.id);
  const jobsValid = jobs.length > 0 && jobIds.every(positive) && new Set(jobIds).size === jobIds.length &&
    (run?.totalJobs === undefined || run.totalJobs === jobs.length);
  const allGreen = runCurrent && jobsValid && run.status === 'completed' &&
    run.conclusion === 'success' && jobs.every(x => x.status === 'completed' && x.conclusion === 'success');
  const executed = runCurrent && typeof run.log === 'string' ? run.log : '';
  const missing = newTests.filter(x => !executed.includes(x.path) || !executed.includes(x.marker))
    .map(x => x.path);
  const discovered = newTests.length > 0 && missing.length === 0 && Boolean(executed);
  const physicalValid = physical?.environment === 'physical-windows' && physical?.status === 'PASS' &&
    exact(physical.installedBuildSha) && physical.installedBuildSha === head &&
    typeof physical.evidenceId === 'string' && physical.evidenceId.trim().length > 0;
  return { head, runId: run?.id ?? null,
    ci: !run ? 'NOT_RUN' : !runCurrent ? 'STALE_OR_UNKNOWN_HEAD' :
      !jobsValid ? 'JOBS_MISSING' : allGreen ? 'REPORTED_ALL_GREEN' : 'CI_NOT_GREEN',
    discovery: discovered ? 'REPORTED_LOG_PATH_AND_MARKER' : 'NOT_VERIFIED', missingTestPaths: missing,
    physical: physicalValid ? 'PHYSICAL_PROOF_REPORTED_NEEDS_REVIEW' : 'NOT_RUN_OR_NOT_VERIFIED',
    accepted: false,
    note: 'Unauthenticated offline input; code/CI/physical/owner acceptance independent' };
}

function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--input')
    throw new Error('Usage: node p006-ci-issue-gate.mjs --input snapshot.json');
  const input = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const report = auditHostedAcceptance(input);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.ci !== 'REPORTED_ALL_GREEN' || report.discovery !== 'REPORTED_LOG_PATH_AND_MARKER')
    process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (e) { console.error(`K20 P006 gate: ${e.message}`); process.exitCode = 2; }
}
