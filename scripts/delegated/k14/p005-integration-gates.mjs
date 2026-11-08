#!/usr/bin/env node
/** Read-only, exact-head PR/CI/test-discovery evidence; never authorizes a merge. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SHA = /^[a-f0-9]{40}$/i;
export const REQUIRED_JOBS = [
  'test (22)', 'test (24)', 'browser-live', 'linux-native-live',
  'wsl2-live', 'security-operational-live', 'macos-agent-lifecycle-live',
];

const exact = value => typeof value === 'string' && SHA.test(value);
const isTest = path => /\.test\.(?:ts|mjs)$/.test(path);

function validate(data) {
  if (!exact(data?.main) || !exact(data?.forkMain) || !exact(data?.priorMain)) throw Error('Invalid main SHA');
  if (!Array.isArray(data?.prs) || data.prs.length !== 31) throw Error('Incomplete P005 31-PR inventory');
  if (!Array.isArray(data?.owners) || data.owners.length !== 2 || !exact(data.ciDiscovery?.workflowBlob)) throw Error('Missing owner/workflow provenance');
  const seen = new Set();
  for (const pr of data.prs) {
    if (!Number.isSafeInteger(pr.number) || seen.has(pr.number) || !exact(pr.head) || !exact(pr.originalHead) || !exact(pr.base)) throw Error('Invalid or duplicate source PR');
    seen.add(pr.number);
    if (!Array.isArray(pr.files) || pr.files.some(file => !file.path || !exact(file.blob))) throw Error(`#${pr.number} incomplete file evidence`);
  }
  for (const owner of data.owners) {
    if (!exact(owner.head) || !Array.isArray(owner.files) || !owner.files.length || owner.files.some(file => !file.path)) throw Error('Missing owner path evidence');
  }
}

export function ciGate(pr) {
  if (pr.headChangedDuringAudit || pr.originalHead !== pr.head) return 'HEAD_MOVED_RECHECK';
  if (pr.run?.head_sha !== pr.head || !Number.isSafeInteger(pr.run?.id)) return 'RUN_HEAD_UNVERIFIED';
  if (pr.run.status !== 'completed') return 'CI_PENDING';
  if (pr.run.conclusion !== 'success') return 'CI_FAILED';
  if (pr.totalJobs !== REQUIRED_JOBS.length || !Array.isArray(pr.jobs) || pr.jobs.length !== pr.totalJobs) return 'JOB_PAGE_INCOMPLETE';
  const names = pr.jobs.map(job => job.name);
  if (REQUIRED_JOBS.some(name => names.filter(item => item === name).length !== 1)) return 'REQUIRED_JOB_MISSING_OR_DUPLICATED';
  if (pr.jobs.some(job => job.run_id !== pr.run.id || job.head_sha !== pr.head || job.status !== 'completed' || job.conclusion !== 'success')) return 'JOB_FAILED_SKIPPED_OR_WRONG_SHA';
  return 'GREEN_SOURCE_JOBS_ONLY';
}

export function discoveryForFile(file, discoveredPaths, npmScript) {
  const explicit = discoveredPaths.some(path => path === file ||
    (path === 'test/delegated/k20/*.test.mjs' && /^test\/delegated\/k20\/[^/]+\.test\.mjs$/.test(file)));
  if (explicit) return 'EXPLICIT_CI_PATH';
  if (file.endsWith('.test.ts') && npmScript.includes('test/**/*.test.ts')) return 'NPM_GLOB_UNVERIFIED';
  return 'NOT_REFERENCED_IN_CI';
}

export function audit(data) {
  validate(data);
  const ownerMap = new Map();
  for (const owner of data.owners) for (const file of owner.files) {
    const array = ownerMap.get(file.path) ?? [];
    array.push(owner.number);
    ownerMap.set(file.path, array);
  }
  const openMap = new Map();
  for (const pr of data.prs) for (const file of pr.files) {
    const array = openMap.get(file.path) ?? [];
    array.push(pr.number);
    openMap.set(file.path, array);
  }
  const newMainPaths = new Set(data.mainCompare?.changedPaths ?? []);
  const explicit = data.ciDiscovery.explicitTests ?? [];
  const prs = data.prs.map(pr => {
    const paths = pr.files.map(f => f.path);
    const tests = paths.filter(isTest).map(path => ({ path,
      proof: discoveryForFile(path, explicit, data.ciDiscovery.npmScript ?? '') }));
    const ci = ciGate(pr);
    const ownerOverlap = paths.filter(path => ownerMap.has(path)).map(path => ({ path, owners: ownerMap.get(path) }));
    const mainOverlap = paths.filter(path => newMainPaths.has(path));
    const crossPrOverlap = paths.filter(path => openMap.get(path)?.length > 1).map(path => ({ path, prs: openMap.get(path) }));
    const testProof = tests.length === 0 ? 'NO_CHANGED_TESTS' :
      tests.every(t => t.proof === 'EXPLICIT_CI_PATH') && ci === 'GREEN_SOURCE_JOBS_ONLY'
        ? 'EXPLICIT_CI_STEPS_SUCCEEDED' : 'NEW_TEST_EXECUTION_UNVERIFIED';
    return {
      number: pr.number, head: pr.head, base: pr.base, ci,
      outdatedBase: pr.base !== data.main,
      baseIsVerifiedAncestor: pr.base === data.priorMain && data.mainCompare?.aheadBy === 1 && data.mainCompare?.behindBy === 0,
      mainOverlap, ownerOverlap, crossPrOverlap, tests, testProof,
      sourceCandidate: ci === 'GREEN_SOURCE_JOBS_ONLY' && testProof === 'EXPLICIT_CI_STEPS_SUCCEEDED' &&
        !mainOverlap.length && !ownerOverlap.length && !crossPrOverlap.length,
      mergeReady: false, physicalAcceptance: 'NOT_RUN',
    };
  }).sort((a,b)=>a.number-b.number);
  const counts = prs.reduce((out,p)=>(out[p.ci]=(out[p.ci]??0)+1,out),{});
  return {
    capturedAt: data.capturedAt, main: data.main, forkMain: data.forkMain,
    synchronized: data.main === data.forkMain,
    oldMainIsAncestor: data.mainCompare?.aheadBy === 1 && data.mainCompare?.behindBy === 0,
    ownerHeads: data.owners.map(o=>({number:o.number,head:o.head,paths:o.files.length})),
    ciWorkflowBlob: data.ciDiscovery.workflowBlob, prs, counts,
    sourceCandidates: prs.filter(p=>p.sourceCandidate).map(p=>p.number),
    mergeAuthorized: false,
    note: 'CI green is source jobs only; test discovery, Draft review, branch protection and physical acceptance are distinct. HEAD movement invalidates stale CI.',
  };
}

export function markdown(report) {
  const lines=[
    '# #1006 — P005 delegated PR integration gates', '',
    `- Upstream/fork main: \`${report.main}\` / \`${report.forkMain}\` (equal: ${report.synchronized})`,
    `- Old main ancestor: ${report.oldMainIsAncestor}`,
    `- PR count: ${report.prs.length}; exact-head CI classification: ${JSON.stringify(report.counts)}`,
    `- Explicit CI-path green source candidates: ${report.sourceCandidates.map(n=>'#'+n).join(', ') || 'NONE'}`,
    '- **No automatic merge, issue closure, device acceptance, or claim of three candidates.**', '',
    '| PR | CI gate | Changed test execution | Main/owner/PR same-path | Base stale |',
    '| --- | --- | --- | ---: | --- |',
    ...report.prs.map(p=>`| #${p.number} | ${p.ci} | ${p.testProof} | ${p.mainOverlap.length}/${p.ownerOverlap.length}/${p.crossPrOverlap.length} | ${p.outdatedBase} |`),
    '', report.note, '',
  ];
  return lines.join('\n');
}

async function main(args) {
  const i=args.indexOf('--offline');
  if (i<0 || !args[i+1]) throw Error('Provide --offline <dated-github-rest-fixture.json>; no implicit network or writes');
  const report=audit(JSON.parse(await readFile(args[i+1], 'utf8')));
  process.stdout.write(args.includes('--json')?`${JSON.stringify(report,null,2)}\n`:markdown(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error=>{console.error(`P005 gate failed: ${error.message}`);process.exitCode=1;});
}
