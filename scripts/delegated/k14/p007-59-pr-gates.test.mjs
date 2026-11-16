import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { audit59, ciGate59, EXPECTED_PR_NUMBERS, fileOverlaps, markdown59, validateSnapshot } from './p007-59-pr-gates.mjs';

const fixturePath = fileURLToPath(new URL('../../../docs/delegated/integration-k14/p007-59-prs-20261108.json', import.meta.url));
const source = JSON.parse(readFileSync(fixturePath, 'utf8'));
const clone = () => structuredClone(source);
const pr = (s, n) => s.prs.find(x => x.number === n);
const count = (r,k) => (r.groups[k] ?? []).length;

test('59 open Draft source PRs exactly; no duplicate or closed PR passes', () => {
  const r = audit59(source);
  assert.equal(r.scannedPrs, 59);
  assert.equal(new Set(EXPECTED_PR_NUMBERS).size, 59);
  assert.deepEqual(r.prs.map(x=>x.number), EXPECTED_PR_NUMBERS);
  for (const mutate of [s=>s.prs.pop(), s=>s.prs[0].number=s.prs[1].number,
    s=>s.prs[0].draft=false, s=>s.prs[0].state='closed']) {
    const broken=clone();mutate(broken);assert.throws(()=>validateSnapshot(broken));
  }
});

test('main/fork SHA, owner SHAs, workflow and individual source file blobs required', () => {
  for (const mutate of [s=>s.forkMain='0'.repeat(40), s=>s.owners[1068].head='unknown',
    s=>s.owners[1096].files=[], s=>s.ciDiscovery.workflowBlob='',
    s=>s.prs[0].files[0].sha='',s=>s.prs[0].firstHead='']) {
    const broken=clone();mutate(broken);assert.throws(()=>audit59(broken));
  }
});

test('HEAD-specific metadata scan rejects missing or malformed full PR bodies/commit messages', () => {
  for (const mutate of [s=>pr(s,1153).metadata.head='f'.repeat(40),
    s=>pr(s,1153).metadata.commits=[],s=>delete pr(s,1153).metadata.body]) {
    const broken=clone();mutate(broken);assert.throws(()=>audit59(broken));
  }
});

test('P007 source CI snapshot reports 39 green, five fail, six zero-job, nine moved', () => {
  const r=audit59(source);
  assert.deepEqual(Object.fromEntries(Object.entries(r.groups).map(([k,v])=>[k,v.length])),{
    ZERO_JOB_ACTION_REQUIRED:6,GREEN_SOURCE_JOBS_ONLY:39,HEAD_MOVED_RECHECK:9,CI_FAILED:5,
  });
  assert.deepEqual(r.groups.ZERO_JOB_ACTION_REQUIRED,[1010,1011,1015,1016,1030,1035]);
  assert.deepEqual(r.groups.CI_FAILED,[1118,1120,1130,1141,1152]);
});

test('zero-job action_required is not a green nor a seven-job failure', () => {
  const sample=pr(source,1010);
  assert.equal(sample.totalJobs,0);
  assert.equal(ciGate59(sample),'ZERO_JOB_ACTION_REQUIRED');
  assert.equal(ciGate59({...sample,run:{...sample.run,head_sha:'f'.repeat(40)}}),'RUN_HEAD_UNVERIFIED');
});

test('head movement takes priority even if older run was green or newer run queued', () => {
  assert.equal(ciGate59(pr(source,1151)),'HEAD_MOVED_RECHECK');
  const good=pr(source,1153);
  assert.equal(ciGate59({...good,head:'f'.repeat(40)}),'HEAD_MOVED_RECHECK');
  assert.equal(ciGate59({...good,firstHead:good.head,run:{...good.run,head_sha:'f'.repeat(40)}}),'RUN_HEAD_UNVERIFIED');
});

test('queued, failed and cancelled runs do not count as green', () => {
  const good=pr(source,1153);
  assert.equal(ciGate59({...good,run:{...good.run,status:'queued',conclusion:null}}),'CI_PENDING');
  assert.equal(ciGate59({...good,run:{...good.run,conclusion:'failure'}}),'CI_FAILED');
  assert.equal(ciGate59({...good,run:{...good.run,conclusion:'cancelled'}}),'CI_FAILED');
});

test('green exact SHA fails closed on absent, duplicated, skipped, wrong-head jobs', () => {
  const good=pr(source,1153);
  assert.equal(ciGate59(good),'GREEN_SOURCE_JOBS_ONLY');
  assert.equal(ciGate59({...good,totalJobs:0,jobs:[]}), 'JOB_PAGE_INCOMPLETE');
  const missing=structuredClone(good);missing.jobs[0].name=missing.jobs[1].name;
  assert.equal(ciGate59(missing),'REQUIRED_JOB_MISSING_OR_DUPLICATED');
  const skipped=structuredClone(good);skipped.jobs[0].conclusion='skipped';
  assert.equal(ciGate59(skipped),'JOB_FAILED_SKIPPED_OR_WRONG_SHA');
  const wrong=structuredClone(good);wrong.jobs[0].head_sha='e'.repeat(40);
  assert.equal(ciGate59(wrong),'JOB_FAILED_SKIPPED_OR_WRONG_SHA');
});

test('all five previously unsafe descriptions neutralized at snapshot; injected keyword caught', () => {
  const r=audit59(source);
  assert.equal(r.allMetadataCleanAtSnapshot,true);
  assert.equal(r.scannedCommitMessages,193);
  assert.equal(r.warnings.length,0);
  for(const n of [1100,1101,1115,1121,1122]) {
    assert.equal(r.prs.find(p=>p.number===n).metadataWarnings.length,0);
  }
  const broken=clone();pr(broken,1100).metadata.body += '\nWe did not fix #485; scope is test only.';
  const findings=audit59(broken).warnings;
  assert.equal(findings.length,1);assert.equal(findings[0].pr,1100);
});

test('owner #1068 four old UI PRs: 15 shared paths, 12 identical, 3 divergent', () => {
  const r=audit59(source);
  assert.equal(r.webOwnerOverlap.length,15);
  assert.equal(r.webOwnerOverlap.filter(x=>x.blobEqual).length,12);
  assert.equal(r.webOwnerOverlap.filter(x=>!x.blobEqual).length,3);
  assert.deepEqual(r.ownerBlocked,[1010,1011,1015,1016]);
  assert.deepEqual(r.webOwnerOverlap.filter(x=>!x.blobEqual).map(x=>x.path).sort(),[
    'test/delegated/k02/responsive-css.test.ts','test/delegated/k03/panel-states.test.mjs','web/app.js',
  ]);
  assert.equal(r.coreOwnerOverlap.length,0);
});

test('owner CI.yml branches have different blobs; K14 does not change it', () => {
  const r=audit59(source);
  assert.equal(r.ownerWorkflowOverlap.length,1);
  assert.equal(r.ownerWorkflowOverlap[0].path,'.github/workflows/ci.yml');
  assert.equal(r.ownerWorkflowOverlap[0].blobEqual,false);
});

test('#1134/#1149 workflow diverges; #1126/#1138 include three identical reused paths', () => {
  const r=audit59(source);
  assert.equal(r.sourcePairOverlaps.length,4);
  const workflow=r.sourcePairOverlaps.find(x=>x.path==='.github/workflows/delegated-noncore.yml');
  assert.deepEqual(workflow.pair,[1134,1149]);assert.equal(workflow.blobEqual,false);
  const redundant=r.sourcePairOverlaps.filter(x=>x.pair.join(',')==='1126,1138');
  assert.equal(redundant.length,3);assert.ok(redundant.every(x=>x.blobEqual));
});

test('K14 PR #1117/#1123/#1140/#1153 use distinct changed paths; semantic evolution still reviewable', () => {
  const candidates=[1117,1123,1140,1153].map(n=>pr(source,n).files);
  for(let i=0;i<candidates.length;i++)for(let j=i+1;j<candidates.length;j++)
    assert.deepEqual(fileOverlaps(candidates[i],candidates[j]),[]);
  assert.ok(pr(source,1117).files.some(x=>x.path.includes('issue1006-audit')));
  assert.ok(pr(source,1140).files.some(x=>x.path.includes('p005-integration-gates')));
  assert.ok(pr(source,1153).files.some(x=>x.path.includes('p006-issue-closing-gates')));
});

test('88 unique changed test paths are classified without claiming hosted execution', () => {
  const r=audit59(source);
  assert.equal(r.newTestPaths,88);
  assert.deepEqual(Object.fromEntries(Object.entries(r.discovery).map(([k,v])=>[k,v.length])),{
    NPM_GLOB_UNVERIFIED:26,HOSTED_TEST_NOT_DISCOVERED:54,EXPLICIT_MAIN_CI_PATH:8,
  });
  assert.equal(r.newTestHostedExecution,'NOT_RUN_OR_NOT_PROVEN');
  assert.equal(r.prs.find(p=>p.number===1153).tests[0].discovery,'HOSTED_TEST_NOT_DISCOVERED');
});

test('no source green implies merge or device acceptance; printable evidence retains every source PR', () => {
  const r=audit59(source), md=markdown59(source);
  assert.equal(r.mergeAuthorized,false);
  assert.equal(r.physicalAcceptance,'NOT_RUN');
  assert.ok(r.prs.every(p=>p.mergeAuthorized===false && p.ownerApproval==='PENDING'));
  assert.match(md,/HEAD_MOVED_RECHECK/);
  for(const n of EXPECTED_PR_NUMBERS) assert.match(md,new RegExp(`\\| #${n} \\|`));
});

test('explicit malicious duplicate changed path or invalid test SHA cannot bypass file audit', () => {
  const s=clone();pr(s,1153).files.push({...pr(s,1153).files[0]});assert.throws(()=>audit59(s),/duplicate/);
  const t=clone();pr(t,1153).files[0].sha='not-a-sha';assert.throws(()=>audit59(t),/invalid/);
});
