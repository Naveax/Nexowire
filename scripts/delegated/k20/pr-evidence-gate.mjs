#!/usr/bin/env node
/** Offline evidence gate. A successful workflow conclusion with zero jobs is NOT PASS. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const exactSha = s => typeof s === 'string' && /^[a-f\d]{40}$/i.test(s);

export function summarizeEvidence(input) {
  if (!exactSha(input?.headSha)) throw new TypeError('Exact 40-character PR HEAD SHA is mandatory');
  const run = input.ci || null;
  if (run && run.headSha && !exactSha(run.headSha)) throw new TypeError('Invalid CI SHA');
  if (run && run.jobs !== undefined && !Array.isArray(run.jobs)) throw new TypeError('CI jobs must be an array');
  const jobs = run?.jobs || [];
  if (jobs.some(x => !Number.isSafeInteger(x?.id) || x.id <= 0 || typeof x.conclusion !== 'string')) {
    throw new TypeError('Every CI job needs a positive numeric ID and conclusion');
  }
  if (new Set(jobs.map(x => x.id)).size !== jobs.length) throw new TypeError('Duplicate job IDs');
  const passed = jobs.filter(x => x.conclusion === 'success').length;
  let verdict = 'NOT_RUN';
  if (run) {
    if (!run.headSha || run.headSha !== input.headSha) verdict = 'STALE';
    else if (run.conclusion === 'action_required') verdict = 'BLOCKED';
    else if (run.conclusion === 'failure' || jobs.some(x => ['failure', 'cancelled', 'timed_out'].includes(x.conclusion))) verdict = 'FAIL';
    else if (run.conclusion === 'success' && Number.isSafeInteger(run.runId) && run.runId > 0 &&
             jobs.length > 0 && passed === jobs.length) verdict = 'REPORTED_SUCCESS_UNVERIFIED';
    else verdict = 'UNKNOWN';
  }
  return { headSha: input.headSha, runId: run?.runId ?? 'NOT_RECORDED',
    jobsTotal: jobs.length, jobsPassed: passed, verdict };
}

export function markdownEvidence(result) {
  return [
    '## PR evidence — exact HEAD / GitHub CI job counts',
    `- Exact HEAD SHA: \`${result.headSha}\``,
    `- CI run: \`${result.runId}\``,
    `- CI jobs: **${result.jobsPassed}/${result.jobsTotal} successful**`,
    `- Evidence verdict: **${result.verdict}**`,
    '- This JSON input is not independently authenticated: REPORTED_SUCCESS_UNVERIFIED never means accepted CI.',
    '- Verify run ID, exact HEAD and job records again directly on GitHub before any acceptance.',
    '',
  ].join('\n');
}

function main() {
  if (process.argv[2] !== '--input' || !process.argv[3] || process.argv.length !== 4) {
    throw new Error('Usage: node pr-evidence-gate.mjs --input snapshot.json');
  }
  const result = summarizeEvidence(JSON.parse(readFileSync(process.argv[3], 'utf8')));
  process.stdout.write(markdownEvidence(result));
  if (result.verdict !== 'REPORTED_SUCCESS_UNVERIFIED') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (err) { console.error(`K20 evidence gate: ${err.message}`); process.exitCode = 2; }
}
