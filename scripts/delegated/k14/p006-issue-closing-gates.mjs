#!/usr/bin/env node
/** P006 read-only, rolling GitHub provenance. No merge/close/re-run operation. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SHA = /^[a-f0-9]{40}$/i;
export const REQUIRED_JOBS = Object.freeze([
  'test (22)', 'test (24)', 'browser-live', 'linux-native-live',
  'wsl2-live', 'security-operational-live', 'macos-agent-lifecycle-live',
]);
const EXPECTED = Array.from({ length: 44 }, (_, i) => i + 1099)
  .filter(number => number !== 1102 && number !== 1135);

// GitHub's closing-keyword matcher does not understand the English negation
// surrounding a keyword. Match the risky token + issue reference even when
// the author says "cannot" or "not" before the keyword.
export function closingReferences(input) {
  if (typeof input !== 'string') return [];
  const pattern = /\b(close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s*:?[ \t]+((?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#([0-9]+))\b/gi;
  return [...input.matchAll(pattern)].map(match => ({
    token: match[1].toLowerCase(), reference: match[2], number: Number(match[3]),
    index: match.index,
  }));
}

export function metadataWarnings({ title = '', body = '', commits = [] } = {}) {
  if (!Array.isArray(commits)) throw Error('commit messages must be an array');
  return [{ field: 'title', value: title }, { field: 'body', value: body },
    ...commits.map((value, index) => ({ field: `commit:${index}`, value }))]
    .flatMap(item => closingReferences(item.value).map(reference => ({ field: item.field, ...reference })));
}

export function metadataAudit(summary, sourcePrs) {
  if (!summary || !Array.isArray(summary.prs) || summary.prs.length !== 42)
    throw Error('PR metadata scan must cover all 42 source PRs');
  if (!Number.isSafeInteger(summary.commitMessages) || summary.commitMessages < 42)
    throw Error('PR metadata commit-message coverage incomplete');
  const byNumber = new Map(sourcePrs.map(pr => [pr.number, pr]));
  const visited = new Set();
  const risky = [];
  const moved = [];
  for (const item of summary.prs) {
    if (visited.has(item.number) || !byNumber.has(item.number) || !SHA.test(item.head ?? '') ||
        !Array.isArray(item.findings)) throw Error('Duplicate or incomplete PR metadata record');
    visited.add(item.number);
    if (byNumber.get(item.number).head !== item.head) moved.push(item.number);
    for (const itemFinding of item.findings) {
      if (!closingReferences(itemFinding.excerpt ?? '').some(f => f.number === itemFinding.number))
        throw Error('Unverifiable metadata warning excerpt');
      risky.push({ prNumber: item.number, head: item.head, ...itemFinding });
    }
  }
  return {
    scannedPrs: visited.size, scannedCommitMessages: summary.commitMessages,
    risky, riskyNumbers: [...new Set(risky.map(f=>f.prNumber))].sort((a,b)=>a-b),
    headMovedSinceMetadataScan: moved.sort((a,b)=>a-b),
    noMergeWhileWarningUnresolved: risky.length > 0 || moved.length > 0,
  };
}

export function incidentGate(value) {
  if (!value || value.issue !== 487 || value.mergedPr !== 1135 || !SHA.test(value.mergedSha ?? ''))
    throw Error('Incident provenance incomplete');
  const { closed, reopened, mergedAt } = value;
  if (!closed?.id || !reopened?.id || !closed.createdAt || !reopened.createdAt || !mergedAt)
    throw Error('Issue close/reopen event IDs or timestamps missing');
  const merged = Date.parse(mergedAt), ended = Date.parse(closed.createdAt), restarted = Date.parse(reopened.createdAt);
  if (![merged, ended, restarted].every(Number.isFinite) || ended < merged || restarted <= ended)
    throw Error('Issue event chronology inconsistent');
  return {
    state: value.currentState === 'open' ? 'REOPENED_NOT_ACCEPTED' : 'ISSUE_NOT_OPEN_REVIEW_REQUIRED',
    elapsedSeconds: (restarted - ended) / 1000,
    directEvidence: 'MERGE_CLOSE_REOPEN_EVENTS',
    rootCause: value.originalPrBodyAvailable === true ? 'ORIGINAL_BODY_AVAILABLE_FOR_REVIEW' : 'OWNER_RETROSPECTIVE_ONLY_ORIGINAL_BODY_UNAVAILABLE',
  };
}

function checkSnapshot(data) {
  if (!SHA.test(data?.main ?? '') || data.main !== data.forkMain || !SHA.test(data?.ciDiscovery?.workflowBlob ?? ''))
    throw Error('Main/fork/workflow provenance incomplete');
  if (!Array.isArray(data.prs) || data.prs.length !== EXPECTED.length) throw Error('42-source-PR page incomplete');
  if (!data.owners || ![1068, 1096].every(n => SHA.test(data.owners[n]?.head ?? '') &&
    Array.isArray(data.owners[n]?.paths) && data.owners[n].paths.length)) throw Error('Owner provenance incomplete');
  if (!Array.isArray(data.mergedPaths) || !data.mergedPaths.length || !Array.isArray(data.ciDiscovery.explicitTests))
    throw Error('Missing merged-path or CI discovery evidence');
  const seen = new Set();
  for (const p of data.prs) {
    if (!EXPECTED.includes(p.number) || seen.has(p.number)) throw Error('Duplicate or unexpected source PR');
    seen.add(p.number);
    if (p.state !== 'open' || p.draft !== true) throw Error('Source PR no longer open Draft');
    if (![p.head, p.firstHead, p.base].every(x => SHA.test(x ?? ''))) throw Error('Missing exact source head/base');
    if (!Array.isArray(p.paths) || !p.paths.length || p.paths.some(x => typeof x !== 'string' || !x)) throw Error('Incomplete source paths');
  }
}

export function ciGate(pr) {
  if (pr.head !== pr.firstHead) return 'HEAD_MOVED_RECHECK';
  if (!Number.isSafeInteger(pr.run?.id) || pr.run.head_sha !== pr.head) return 'RUN_HEAD_UNVERIFIED';
  if (pr.run.status !== 'completed') return 'CI_PENDING';
  if (pr.run.conclusion !== 'success') return 'CI_FAILED';
  if (pr.totalJobs !== 7 || !Array.isArray(pr.jobs) || pr.jobs.length !== 7) return 'JOB_PAGE_INCOMPLETE';
  for (const name of REQUIRED_JOBS) if (pr.jobs.filter(j => j.name === name).length !== 1)
    return 'REQUIRED_JOB_MISSING_OR_DUPLICATED';
  if (pr.jobs.some(j => j.run_id !== pr.run.id || j.head_sha !== pr.head ||
      j.status !== 'completed' || j.conclusion !== 'success')) return 'JOB_FAILED_SKIPPED_OR_WRONG_SHA';
  return 'GREEN_SOURCE_JOBS_ONLY';
}

export function testDiscovery(path, explicitTests, npmPattern) {
  if (explicitTests.some(pattern => pattern === path ||
      (pattern === 'test/delegated/k20/*.test.mjs' &&
       /^test\/delegated\/k20\/[^/]+\.test\.mjs$/.test(path)))) return 'EXPLICIT_MAIN_CI_PATH';
  if (path.endsWith('.test.ts') && npmPattern === 'test/**/*.test.ts') return 'NPM_GLOB_UNVERIFIED';
  return 'HOSTED_TEST_NOT_DISCOVERED';
}

function ownerRelevance(pr) {
  // Semantic *review*, never a claim of a textual conflict. A shared issue
  // surface may interact with an owner branch despite zero equal file paths.
  const subject = (pr.title ?? '').toLowerCase();
  const web = /\b(ui|web|browser|onboarding|pairing|admin|responsive|mobile|connect|status|bridge)\b/i.test(subject);
  const core = /\b(core|broker|wal|sqlite|windows|process|taskkill|auth|guardian)\b/i.test(subject);
  return [web && 1068, core && 1096].filter(Boolean);
}

export function audit(data, metadata = null) {
  checkSnapshot(data);
  const incident = incidentGate(data.incident);
  const owners = new Map();
  for (const n of [1068, 1096]) for (const path of data.owners[n].paths) {
    const current = owners.get(path) ?? [];
    owners.set(path, [...current, n]);
  }
  const sourcePaths = new Map();
  for (const pr of data.prs) for (const path of pr.paths) sourcePaths.set(path, [...sourcePaths.get(path) ?? [], pr.number]);
  const merged = new Set(data.mergedPaths);
  const prs = data.prs.map(pr => {
    const ci = ciGate(pr);
    const tests = pr.paths.filter(path => /\.test\.(?:mjs|ts)$/.test(path)).map(path => ({
      path, discovery: testDiscovery(path, data.ciDiscovery.explicitTests, data.ciDiscovery.npmPattern),
    }));
    const samePathOwner = pr.paths.filter(path => owners.has(path)).map(path => ({ path, owners: owners.get(path) }));
    const samePathMain = pr.paths.filter(path => merged.has(path));
    const samePathSource = pr.paths.filter(path => (sourcePaths.get(path) ?? []).length > 1);
    const semanticOwnerReview = ownerRelevance(pr);
    const allTestsSelected = tests.length > 0 && tests.every(t => t.discovery === 'EXPLICIT_MAIN_CI_PATH');
    const proof = ci === 'GREEN_SOURCE_JOBS_ONLY' && allTestsSelected
      ? 'MAIN_CI_TEST_PATH_PRESENT_SOURCE_JOBS_GREEN' : 'NEW_TEST_HOSTED_EXECUTION_UNVERIFIED';
    return {
      number: pr.number, head: pr.head, base: pr.base, ci,
      tests, proof, outdatedBase: pr.base !== data.main,
      samePathOwner, samePathMain, samePathSource, semanticOwnerReview,
      ownerDecision: samePathOwner.length || semanticOwnerReview.length ? 'REVIEW_REQUIRED' : 'NO_EXACT_OWNER_COLLISION_REVIEW_STILL_REQUIRED',
      sourceReviewCandidate: ci === 'GREEN_SOURCE_JOBS_ONLY' &&
        !samePathOwner.length && !samePathMain.length && !samePathSource.length,
      mergeAuthorized: false, productionAcceptance: 'NOT_RUN',
    };
  }).sort((a,b)=>a.number-b.number);
  const meta = metadata ? metadataAudit(metadata, data.prs) : null;
  const flagged = new Set(meta?.riskyNumbers ?? []);
  if (meta) for (const p of prs) {
    p.metadataClosingWarning = flagged.has(p.number);
    if (p.metadataClosingWarning) p.sourceReviewCandidate = false;
  }
  const counts = {};
  for (const p of prs) counts[p.ci] = (counts[p.ci] ?? 0) + 1;
  return {
    capturedAt: data.capturedAt, main: data.main, forkMain: data.forkMain,
    ciWorkflowBlob: data.ciDiscovery.workflowBlob, incident,
    ownerHeads: Object.fromEntries([1068,1096].map(n => [n, data.owners[n].head])),
    prs, counts, metadata: meta, complete: prs.length === 42,
    exactOwnerPathOverlap: prs.reduce((n,p)=>n+p.samePathOwner.length,0),
    exactMainPathOverlap: prs.reduce((n,p)=>n+p.samePathMain.length,0),
    crossPrSamePath: prs.reduce((n,p)=>n+p.samePathSource.length,0),
    verifiedNewTestCandidates: prs.filter(p=>p.proof === 'MAIN_CI_TEST_PATH_PRESENT_SOURCE_JOBS_GREEN'
      && p.sourceReviewCandidate).map(p=>p.number),
    reviewOnlyShortlist: [1127,1123,1119].filter(n=>prs.find(p=>p.number===n)?.sourceReviewCandidate),
    mergeAuthorized: false,
  };
}

export function markdown(data, metadata = null) {
  const r = audit(data, metadata);
  return [
    '# #1006 P006 read-only delegated integration evidence', '',
    `- Snapshot: ${r.capturedAt} (rolling; subject to HEAD drift)`,
    `- Main/fork: \`${r.main}\` / \`${r.forkMain}\``,
    `- Incident: ${r.incident.state}; close/reopen gap ${r.incident.elapsedSeconds} seconds; cause ${r.incident.rootCause}`,
    `- 42 PR exact-head CI: ${JSON.stringify(r.counts)}`,
    `- PR description/commit closing-keyword warnings: ${r.metadata ? r.metadata.riskyNumbers.map(n=>'#'+n).join(', ') || 'NONE' : 'SCAN_NOT_SUPPLIED'}`,
    `- Metadata HEAD drift: ${r.metadata?.headMovedSinceMetadataScan.join(', ') || 'UNASSESSED'}`,
    `- Same-path overlaps owner/main/cross-PR: ${r.exactOwnerPathOverlap}/${r.exactMainPathOverlap}/${r.crossPrSamePath}`,
    `- Full new-test discovery + green candidates: ${r.verifiedNewTestCandidates.join(', ') || 'NONE'}`,
    `- Conditional read-only source review shortlist: ${r.reviewOnlyShortlist.join(', ') || 'NONE'}`,
    '- Merge allowed: NO. Physical/Windows/provider acceptance: NOT_RUN.', '',
    '| PR | Exact CI | Newly changed test proof | Owner review | Stale base |',
    '| --- | --- | --- | --- | --- |',
    ...r.prs.map(p=>`| #${p.number} | ${p.ci} | ${p.proof} | ${p.ownerDecision} | ${p.outdatedBase} |`),
    '', 'This is not a complete mergeable-state or physical-acceptance certification.', '',
  ].join('\n');
}

async function main(args) {
  const at = args.indexOf('--offline');
  if (at === -1 || !args[at + 1]) throw Error('Usage: --offline <snapshot.json>');
  const snapshot = JSON.parse(await readFile(args[at+1], 'utf8'));
  const metaAt = args.indexOf('--metadata');
  const metadata = metaAt === -1 ? null : JSON.parse(await readFile(args[metaAt+1], 'utf8'));
  process.stdout.write(args.includes('--json') ? JSON.stringify(audit(snapshot, metadata), null, 2) + '\n' : markdown(snapshot, metadata));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;});
