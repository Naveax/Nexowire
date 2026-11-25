#!/usr/bin/env node
/** P007 offline integration inventory. This module never merges, dispatches CI, or closes issues. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { REQUIRED_JOBS, metadataWarnings, testDiscovery } from './p006-issue-closing-gates.mjs';

const SHA = /^[a-f0-9]{40}$/i;
export const EXPECTED_PR_NUMBERS = Object.freeze([
  1010, 1011, 1015, 1016, 1030, 1035,
  ...Array.from({ length: 55 }, (_, i) => 1099 + i).filter(n => n !== 1102 && n !== 1135),
].sort((a, b) => a - b));

function assert(condition, reason) {
  if (!condition) throw Error(reason);
}

function requireFileList(files, label) {
  assert(Array.isArray(files) && files.length > 0, `${label}: no changed files`);
  const seen = new Set();
  for (const file of files) {
    assert(typeof file.path === 'string' && file.path.length && SHA.test(file.sha ?? ''), `${label}: invalid file/blob`);
    assert(!seen.has(file.path), `${label}: duplicate changed path`);
    seen.add(file.path);
  }
}

export function validateSnapshot(data) {
  assert(SHA.test(data?.upstreamMain ?? '') && data.upstreamMain === data.forkMain, 'main/fork exact SHA mismatch');
  assert(Date.parse(data.capturedAt) > 0, 'missing capture time');
  assert(SHA.test(data.ciDiscovery?.workflowBlob ?? '') &&
    Array.isArray(data.ciDiscovery.explicitTests) &&
    data.ciDiscovery.npmPattern === 'test/**/*.test.ts', 'incomplete main-CI provenance');
  assert(Array.isArray(data.prs) && data.prs.length === EXPECTED_PR_NUMBERS.length, '59-source-PR inventory incomplete');
  for (const n of [1068, 1096]) {
    assert(SHA.test(data.owners?.[n]?.head ?? ''), `owner #${n} exact SHA missing`);
    requireFileList(data.owners[n].files, `owner #${n}`);
  }
  const seen = new Set();
  for (const pr of data.prs) {
    assert(EXPECTED_PR_NUMBERS.includes(pr.number) && !seen.has(pr.number), 'duplicate or unknown PR number');
    seen.add(pr.number);
    assert(pr.state === 'open' && pr.draft === true, `#${pr.number} not open Draft`);
    assert([pr.head, pr.firstHead, pr.base].every(s => SHA.test(s ?? '')), `#${pr.number} lacks immutable SHA`);
    requireFileList(pr.files, `source #${pr.number}`);
    assert(pr.metadata?.head === pr.head && typeof pr.metadata.title === 'string' &&
      typeof pr.metadata.body === 'string' && Array.isArray(pr.metadata.commits) &&
      pr.metadata.commits.length > 0, `#${pr.number} incomplete HEAD-specific metadata scan`);
  }
}

export function ciGate59(pr) {
  if (pr.head !== pr.firstHead) return 'HEAD_MOVED_RECHECK';
  if (!Number.isSafeInteger(pr.run?.id) || pr.run?.head_sha !== pr.head) return 'RUN_HEAD_UNVERIFIED';
  if (pr.run.status === 'completed' && pr.run.conclusion === 'action_required' &&
    pr.totalJobs === 0 && Array.isArray(pr.jobs) && pr.jobs.length === 0) return 'ZERO_JOB_ACTION_REQUIRED';
  if (pr.run.status !== 'completed') return 'CI_PENDING';
  if (pr.run.conclusion !== 'success') return 'CI_FAILED';
  if (pr.totalJobs !== REQUIRED_JOBS.length || !Array.isArray(pr.jobs) ||
      pr.jobs.length !== REQUIRED_JOBS.length) return 'JOB_PAGE_INCOMPLETE';
  for (const name of REQUIRED_JOBS) if (pr.jobs.filter(j => j.name === name).length !== 1)
    return 'REQUIRED_JOB_MISSING_OR_DUPLICATED';
  if (pr.jobs.some(j => j.run_id !== pr.run.id || j.head_sha !== pr.head ||
      j.status !== 'completed' || j.conclusion !== 'success')) return 'JOB_FAILED_SKIPPED_OR_WRONG_SHA';
  return 'GREEN_SOURCE_JOBS_ONLY';
}

export function fileOverlaps(a, b) {
  requireFileList(a, 'left side');
  requireFileList(b, 'right side');
  const byPath = new Map(b.map(f => [f.path, f.sha]));
  return a.filter(f => byPath.has(f.path)).map(f => ({
    path: f.path, blobEqual: f.sha === byPath.get(f.path), leftBlob: f.sha, rightBlob: byPath.get(f.path),
  }));
}

export function audit59(data) {
  validateSnapshot(data);
  const prs = data.prs.map(pr => {
    const ci = ciGate59(pr);
    const metadataWarningsAtCapture = metadataWarnings(pr.metadata);
    const tests = pr.files.filter(f => /\.test\.(?:ts|mjs)$/.test(f.path)).map(f => ({
      path: f.path, discovery: testDiscovery(f.path, data.ciDiscovery.explicitTests, data.ciDiscovery.npmPattern),
    }));
    const webOwnerOverlap = fileOverlaps(pr.files, data.owners[1068].files);
    const coreOwnerOverlap = fileOverlaps(pr.files, data.owners[1096].files);
    return {
      number: pr.number, head: pr.head, firstHead: pr.firstHead,
      base: pr.base, ci, runId: pr.run?.id ?? null, runHead: pr.run?.head_sha ?? null,
      totalJobs: pr.totalJobs, metadataMessages: pr.metadata.commits.length,
      metadataWarnings: metadataWarningsAtCapture, tests, webOwnerOverlap, coreOwnerOverlap,
      mainBaseChanged: pr.base !== data.upstreamMain,
      newTestHostedExecution: 'NOT_PROVEN_BY_GENERIC_CI',
      ownerApproval: 'PENDING', productionAcceptance: 'NOT_RUN', mergeAuthorized: false,
    };
  }).sort((a, b) => a.number - b.number);
  const groups = {};
  for (const pr of prs) (groups[pr.ci] ??= []).push(pr.number);
  const pairOverlaps = [];
  for (let i = 0; i < data.prs.length; i++) for (let j = i + 1; j < data.prs.length; j++) {
    const a = data.prs[i], b = data.prs[j];
    for (const overlap of fileOverlaps(a.files, b.files))
      pairOverlaps.push({ pair: [Math.min(a.number, b.number), Math.max(a.number, b.number)], ...overlap });
  }
  pairOverlaps.sort((a, b) => a.pair[0] - b.pair[0] || a.pair[1] - b.pair[1] || a.path.localeCompare(b.path));
  const ownerWorkflowOverlap = fileOverlaps(data.owners[1068].files, data.owners[1096].files);
  const uniqueTests = [...new Map(prs.flatMap(p => p.tests.map(t => [t.path, t]))).values()];
  const discovery = {};
  for (const t of uniqueTests) (discovery[t.discovery] ??= []).push(t.path);
  const warnings = prs.flatMap(p => p.metadataWarnings.map(w => ({ pr: p.number, ...w })));
  const ownerBlocked = prs.filter(p => p.webOwnerOverlap.length || p.coreOwnerOverlap.length).map(p => p.number);
  const sourceCollisionPRs = [...new Set(pairOverlaps.flatMap(p => p.pair))].sort((a,b)=>a-b);
  return {
    capturedAt: data.capturedAt, upstreamMain: data.upstreamMain,
    ownerHeads: { 1068: data.owners[1068].head, 1096: data.owners[1096].head },
    workflowBlob: data.ciDiscovery.workflowBlob, scannedPrs: prs.length,
    scannedCommitMessages: prs.reduce((n,p)=>n+p.metadataMessages,0),
    groups, prs, warnings, allMetadataCleanAtSnapshot: warnings.length === 0,
    webOwnerOverlap: prs.flatMap(p => p.webOwnerOverlap.map(o => ({ pr:p.number, ...o }))),
    coreOwnerOverlap: prs.flatMap(p => p.coreOwnerOverlap.map(o => ({ pr:p.number, ...o }))),
    ownerWorkflowOverlap, sourcePairOverlaps: pairOverlaps,
    ownerBlocked, sourceCollisionPRs, discovery,
    newTestPaths: uniqueTests.length,
    newTestHostedExecution: 'NOT_RUN_OR_NOT_PROVEN',
    sourceOnlyReviewCandidates: prs.filter(p => p.ci === 'GREEN_SOURCE_JOBS_ONLY' &&
      !ownerBlocked.includes(p.number) && !sourceCollisionPRs.includes(p.number) &&
      p.metadataWarnings.length === 0).map(p => p.number),
    historicalSnapshot: true, mergeAuthorized: false, ownerApproval: 'PENDING', physicalAcceptance: 'NOT_RUN',
  };
}

export function markdown59(data) {
  const r = audit59(data);
  const groupCounts = Object.fromEntries(Object.entries(r.groups).map(([k,v])=>[k,v.length]));
  const discoveryCounts = Object.fromEntries(Object.entries(r.discovery).map(([k,v])=>[k,v.length]));
  return [
    '# P007 — 59 open Draft PR source audit (owner approval pending)', '',
    `Snapshot: ${r.capturedAt}; main=${r.upstreamMain}; workflow blob=${r.workflowBlob}.`,
    `PRs=${r.scannedPrs}, commit messages=${r.scannedCommitMessages}; **historical rolling observation**, not live lock.`,
    `Exact-head CI groups: ${JSON.stringify(groupCounts)}. HEAD_MOVED_RECHECK takes precedence over old CI.`,
    `Current snapshot metadata warnings=${r.warnings.length}; five previously hazardous PR descriptions neutralized. Re-scan after moving heads.`,
    `Unique changed test paths=${r.newTestPaths}; discovery=${JSON.stringify(discoveryCounts)}. Green seven-job result does not establish actual nested test execution.`,
    `Owner #1068 same-path=${r.webOwnerOverlap.length}, identical=${r.webOwnerOverlap.filter(o=>o.blobEqual).length}, divergent=${r.webOwnerOverlap.filter(o=>!o.blobEqual).length}; owner #1096=${r.coreOwnerOverlap.length}.`,
    `#1068/#1096 owner-vs-owner same-path=${r.ownerWorkflowOverlap.length}; source pairs=${r.sourcePairOverlaps.length}.`,
    `Owner-blocked source PRs=${r.ownerBlocked.join(', ')}; source path-collision PRs=${r.sourceCollisionPRs.join(', ')}.`,
    'All candidate lists mean **read-only source review**, not merge authority, physical acceptance, or functional/hosted PASS.', '',
    '| PR | SHA | Exact-head CI at capture | owner overlap | new tests | metadata |',
    '| --- | --- | --- | --- | --- | --- |',
    ...r.prs.map(p=>`| #${p.number} | ${p.head.slice(0,12)} | ${p.ci} | ${p.webOwnerOverlap.length+p.coreOwnerOverlap.length} | ${p.tests.length} | ${p.metadataWarnings.length} |`),
    '', 'No upstream/owner workflow/runtime or issue state was changed by this audit.', '',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--offline');
  if (i < 0 || !process.argv[i+1]) throw Error('Usage: --offline <snapshot.json> [--json]');
  readFile(process.argv[i+1], 'utf8').then(JSON.parse).then(s=>
    process.stdout.write(process.argv.includes('--json') ? JSON.stringify(audit59(s),null,2)+'\n' : markdown59(s))
  ).catch(e=>{console.error(e.message);process.exitCode=1;});
}
