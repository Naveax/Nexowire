/** P005 read-only PR/CI evidence. No network, release decisions, or CI reruns. */
const SHA = /^[0-9a-f]{40}$/i;
const exact = x => typeof x === 'string' && SHA.test(x);
const positive = x => Number.isSafeInteger(x) && x > 0;

/** Distinguishes a TAP test failure from a brittle workflow's fixed total. */
export function auditTapGate({ workflow, tap, tapFile, prHead, logHead, jobConclusion }) {
  if (typeof workflow !== 'string' || typeof tap !== 'string' ||
      !/^[\w.-]+\.tap$/.test(tapFile) || !exact(prHead) || !exact(logHead)) {
    throw new TypeError('Exact PR and log HEAD with workflow/TAP contents required');
  }
  const normalizedTap = tap.split('\n').map(line =>
    line.replace(/^\d{4}-\d\d-\d\dT[^\s]+Z\s+/, '')).join('\n');
  const fields = Object.fromEntries(['tests', 'pass', 'fail', 'skipped', 'todo']
    .map(name => [name, [...normalizedTap.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))].map(x => Number(x[1]))]));
  if (Object.values(fields).some(values => values.length !== 1))
    return { verdict: 'UNKNOWN_TAP', gate: 'NOT_EVALUATED' };
  const line = workflow.split('\n').filter(x => x.includes(tapFile));
  const extractPin = kind => line.flatMap(x => [...x.matchAll(new RegExp(`grep\\s+-qx\\s+['"]# ${kind} (\\d+)['"]`, 'g'))]
    .map(y => Number(y[1])));
  const testPins = extractPin('tests');
  const passPins = extractPin('pass');
  const result = Object.fromEntries(Object.entries(fields).map(([key,values]) => [key,values[0]]));
  if (prHead !== logHead) return { verdict: 'STALE_HEAD', gate: 'NOT_EVALUATED', result };
  const assertionsGreen = result.tests > 0 && result.pass === result.tests &&
    result.fail === 0 && result.skipped === 0 && result.todo === 0;
  if (!assertionsGreen) return { verdict: 'ASSERTION_INCOMPLETE_OR_FAILED', gate: 'RED', result };
  const hasPins = testPins.length > 0 && passPins.length > 0;
  const pinMatch = hasPins && testPins.every(x => x === result.tests) &&
    passPins.every(x => x === result.pass);
  const gate = !hasPins ? 'NO_FIXED_TOTAL_PIN' : pinMatch ? 'MATCH' : 'COUNT_DRIFT';
  return { verdict: gate === 'COUNT_DRIFT' && jobConclusion === 'failure'
    ? 'ASSERTIONS_GREEN_WORKFLOW_RED' : 'REPORTED_TAP_GREEN_NOT_ACCEPTANCE',
  gate, pins: { tests: testPins, pass: passPins }, result };
}

/** A green 7/7 job set is not evidence that newly added tests were discovered. */
export function classifyPrReviewEvidence(entry) {
  if (!positive(entry?.number) || !exact(entry.headSha) ||
      !['open', 'closed'].includes(entry.prState) ||
      !Array.isArray(entry.jobs)) throw new TypeError('Malformed PR evidence entry');
  const merged = Boolean(entry.mergedAt);
  if (merged && (entry.prState !== 'closed' || !Number.isFinite(Date.parse(entry.mergedAt))))
    throw new TypeError('Inconsistent merged_at');
  const lifecycle = merged ? 'MERGED' : entry.prState === 'closed' ? 'CLOSED_UNMERGED' : 'OPEN';
  let ci = 'NO_VERIFIED_RUN';
  if (entry.run) {
    if (entry.run.headSha !== entry.headSha) ci = 'STALE_HEAD';
    else if (!positive(entry.run.id) || !Number.isSafeInteger(entry.run.totalJobs) ||
             entry.run.totalJobs !== entry.jobs.length || entry.jobs.length === 0) ci = 'INCOMPLETE_JOBS';
    else if (entry.run.status !== 'completed' || entry.run.conclusion !== 'success' ||
             entry.jobs.some(j => j.status !== 'completed' || j.conclusion !== 'success')) ci = 'CI_NOT_GREEN';
    else ci = entry.jobs.length === 7 ? 'REPORTED_7_OF_7_GREEN'
      : `REPORTED_${entry.jobs.length}_OF_${entry.jobs.length}_GREEN_NOT_SEVEN`;
  }
  const requested = entry.newTestPaths;
  const discovered = entry.executedTestPaths;
  let discovery = 'NOT_VERIFIED';
  if (Array.isArray(requested) && Array.isArray(discovered)) {
    discovery = requested.every(p => typeof p === 'string' && discovered.includes(p))
      ? 'REPORTED_PATH_COVERAGE' : 'MISSING_TEST_DISCOVERY';
  }
  const physical = entry.physical?.environment === 'physical-windows' &&
    entry.physical?.status === 'PASS' && entry.physical?.evidenceId
    ? 'PHYSICAL_PASS_REPORTED_UNVERIFIED' : 'NOT_RUN_OR_UNVERIFIED';
  return { number: entry.number, headSha: entry.headSha, lifecycle, ci,
    discovery, physical, ownerAcceptance: 'NOT_INFERRED' };
}

/** Missing, duplicate or out-of-range PRs invalidate a claimed complete cohort. */
export function summarizePrCohort(entries, { first = 1099, last = 1130 } = {}) {
  if (!Array.isArray(entries) || !positive(first) || !positive(last) || last < first)
    throw new TypeError('Invalid PR cohort range');
  const byNumber = new Map();
  for (const entry of entries) {
    const classified = classifyPrReviewEvidence(entry);
    if (classified.number < first || classified.number > last || byNumber.has(classified.number))
      throw new TypeError('Duplicate or out-of-range PR entry');
    byNumber.set(classified.number, classified);
  }
  const missing = [];
  for (let n = first; n <= last; n++) if (!byNumber.has(n)) missing.push(n);
  const prs = [...byNumber.values()].sort((a, b) => a.number - b.number);
  const counts = { merged: prs.filter(x => x.lifecycle === 'MERGED').length,
    open: prs.filter(x => x.lifecycle === 'OPEN').length,
    ciReported7of7: prs.filter(x => x.ci === 'REPORTED_7_OF_7_GREEN').length,
    ciNotGreen: prs.filter(x => x.ci === 'CI_NOT_GREEN').length,
    discoveryNotVerified: prs.filter(x => x.discovery === 'NOT_VERIFIED').length,
    physicalNotVerified: prs.filter(x => x.physical === 'NOT_RUN_OR_UNVERIFIED').length };
  return { complete: missing.length === 0 && prs.length === last - first + 1,
    missing, counts, prs };
}

/** PR HEAD drift invalidates a previously green workflow even if runId exists. */
export function detectOwnerHeadDrift({ prNumber, recordedHead, currentHead, runHead, runConclusion }) {
  if (!positive(prNumber) || ![recordedHead,currentHead,runHead].every(exact))
    throw new TypeError('Full 40-character SHA proof required');
  return { prNumber, currentHead, verdict: recordedHead !== currentHead ||
    runHead !== currentHead ? 'STALE_EVIDENCE' : runConclusion === 'success'
      ? 'CURRENT_HEAD_REPORTED_GREEN_ONLY' : 'CURRENT_HEAD_NOT_GREEN' };
}
