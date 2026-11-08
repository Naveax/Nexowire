import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  audit, ciGate, closingReferences, metadataWarnings, incidentGate,
  testDiscovery, markdown, REQUIRED_JOBS, metadataAudit,
} from './p006-issue-closing-gates.mjs';

const fixture = JSON.parse(await readFile(new URL('../../../docs/delegated/integration-k14/p006-42-prs-20261108.json', import.meta.url), 'utf8'));
const meta = JSON.parse(await readFile(new URL('../../../docs/delegated/integration-k14/p006-closing-metadata-20261108.json', import.meta.url), 'utf8'));
const clone = () => structuredClone(fixture);
const find = (set, n) => set.prs.find(p => p.number === n);

test('P006 has 42 open Drafts, excludes two truly merged PRs, and pins main/fork', () => {
  const r = audit(fixture);
  assert.equal(r.complete, true);
  assert.equal(r.prs.length, 42);
  assert.ok(!r.prs.some(p => p.number === 1102 || p.number === 1135));
  assert.equal(r.main, '52d452f717d891eeaf4c2b9aff3c6e1ea68369b0');
  assert.equal(r.main, r.forkMain);
  assert.equal(r.mergeAuthorized, false);
});

test('actual 487 incident is anchored to GitHub merge/close/reopen event IDs', () => {
  const r = incidentGate(fixture.incident);
  assert.deepEqual([fixture.incident.closed.id, fixture.incident.reopened.id], [35491107606, 35491190126]);
  assert.equal(r.directEvidence, 'MERGE_CLOSE_REOPEN_EVENTS');
  assert.equal(r.state, 'REOPENED_NOT_ACCEPTED');
  assert.equal(r.elapsedSeconds, 131);
  assert.equal(r.rootCause, 'OWNER_RETROSPECTIVE_ONLY_ORIGINAL_BODY_UNAVAILABLE');
});

test('negated issue-closing keyword in a PR body is still flagged', () => {
  const a = metadataWarnings({ body: 'We cannot close #487 until live capacity is verified.' });
  assert.equal(a.length, 1);
  assert.deepEqual([a[0].field, a[0].token, a[0].number], ['body', 'close', 487]);
});

test('all three supported GitHub closing verb families flag negation', () => {
  const inputs = ['not fixes #487', 'never resolved #539', 'cannot close #1006'];
  assert.deepEqual(inputs.map(x => closingReferences(x)[0]?.number), [487, 539, 1006]);
});

test('mixed-case, trailing comma and owner/repo syntax are covered', () => {
  const a = closingReferences('Cannot FIXES Naveax/Nexowire#487, must not Resolve: #539.');
  assert.deepEqual(a.map(x => x.number), [487, 539]);
});

test('neutral issue references and technical fix commit subject are not closing instructions', () => {
  const good = 'Refs #487 and #539. Issue #487 remains OPEN. fix(ops): rounded evidence (#1135).';
  assert.deepEqual(metadataWarnings({ title: 'test: inspect #1006', body: good }), []);
});

test('PR title and commit messages are scanned independently of body', () => {
  const warnings = metadataWarnings({
    title: 'This will fix #487',
    body: 'Refs #487',
    commits: ['Do not resolve #539 yet', 'test: offline only'],
  });
  assert.deepEqual(warnings.map(x => x.field), ['title', 'commit:0']);
  assert.deepEqual(warnings.map(x => x.number), [487, 539]);
});

test('exact-head CI snapshot keeps failed, pending, missing and moved separate from green', () => {
  const r = audit(fixture);
  assert.deepEqual(r.counts, {
    GREEN_SOURCE_JOBS_ONLY: 29,
    RUN_HEAD_UNVERIFIED: 2,
    HEAD_MOVED_RECHECK: 5,
    CI_PENDING: 2,
    CI_FAILED: 4,
  });
  assert.deepEqual(r.prs.filter(p=>p.ci === 'CI_FAILED').map(p=>p.number), [1118,1120,1130,1141]);
  assert.deepEqual(r.prs.filter(p=>p.ci === 'RUN_HEAD_UNVERIFIED').map(p=>p.number), [1100,1109]);
  assert.deepEqual(r.prs.filter(p=>p.ci === 'CI_PENDING').map(p=>p.number), [1114,1131]);
});

test('P006 moved HEAD cannot inherit an older successful 7/7 workflow', () => {
  const r = audit(fixture);
  assert.deepEqual(r.prs.filter(p=>p.ci === 'HEAD_MOVED_RECHECK').map(p=>p.number), [1105,1108,1110,1138,1142]);
  const p = find(clone(), 1123);
  p.head='a'.repeat(40);
  assert.equal(ciGate(p),'HEAD_MOVED_RECHECK');
});

test('failed Node (22) and WSL2 are negative even if other 6 jobs passed', () => {
  assert.equal(ciGate(find(fixture,1118)), 'CI_FAILED');
  assert.equal(ciGate(find(fixture,1120)), 'CI_FAILED');
  assert.equal(ciGate(find(fixture,1130)), 'CI_FAILED');
  assert.equal(ciGate(find(fixture,1141)), 'CI_FAILED');
});

test('a fake successful overall run fails if one job was skipped', () => {
  const p=find(clone(),1123);
  p.jobs[0].conclusion='skipped';
  assert.equal(ciGate(p),'JOB_FAILED_SKIPPED_OR_WRONG_SHA');
  p.jobs[0].conclusion='success';
  p.jobs[0].head_sha='f'.repeat(40);
  assert.equal(ciGate(p),'JOB_FAILED_SKIPPED_OR_WRONG_SHA');
});

test('wrong run id, absent job, duplicate required job and head mismatch fail closed', () => {
  const p=find(clone(),1123);
  p.run.head_sha='0'.repeat(40);
  assert.equal(ciGate(p),'RUN_HEAD_UNVERIFIED');
  p.run.head_sha=p.head;
  p.jobs.pop();
  assert.equal(ciGate(p),'JOB_PAGE_INCOMPLETE');
  p.jobs=REQUIRED_JOBS.map((name,i)=>({name:i===6?REQUIRED_JOBS[0]:name,status:'completed',conclusion:'success',run_id:p.run.id,head_sha:p.head}));
  assert.equal(ciGate(p),'REQUIRED_JOB_MISSING_OR_DUPLICATED');
});

test('a green CI workflow does not discover new nested K14 MJS tests', () => {
  const r=audit(fixture);
  for (const n of [1117,1123,1140]) {
    const p=r.prs.find(x=>x.number===n);
    assert.equal(p.ci,'GREEN_SOURCE_JOBS_ONLY');
    assert.ok(p.tests.every(t=>t.discovery==='HOSTED_TEST_NOT_DISCOVERED'));
    assert.equal(p.proof,'NEW_TEST_HOSTED_EXECUTION_UNVERIFIED');
  }
  assert.deepEqual(r.verifiedNewTestCandidates, []);
});

test('K20 explicit glob covers only direct child and not all MJS in repo', () => {
  const exp=fixture.ciDiscovery.explicitTests;
  assert.equal(testDiscovery('test/delegated/k20/issue-evidence-audit.test.mjs',exp,fixture.ciDiscovery.npmPattern),'EXPLICIT_MAIN_CI_PATH');
  assert.equal(testDiscovery('test/delegated/k20/nested/unseen.test.mjs',exp,fixture.ciDiscovery.npmPattern),'HOSTED_TEST_NOT_DISCOVERED');
  assert.equal(testDiscovery('scripts/delegated/k14/p006-issue-closing-gates.test.mjs',exp,fixture.ciDiscovery.npmPattern),'HOSTED_TEST_NOT_DISCOVERED');
});

test('one explicitly selected TS test never covers another new TS test via assumption', () => {
  const r=audit(fixture).prs.find(p=>p.number===1107);
  assert.equal(r.tests.length,2);
  assert.deepEqual(new Set(r.tests.map(x=>x.discovery)), new Set(['EXPLICIT_MAIN_CI_PATH','NPM_GLOB_UNVERIFIED']));
  assert.equal(r.proof,'NEW_TEST_HOSTED_EXECUTION_UNVERIFIED');
});

test('same-path overlaps and semantic owner review are independent', () => {
  const r=audit(fixture);
  assert.deepEqual([r.exactOwnerPathOverlap,r.exactMainPathOverlap,r.crossPrSamePath],[0,0,0]);
  const web=r.prs.find(p=>p.number===1101);
  assert.deepEqual(web.semanticOwnerReview,[1068]);
  assert.equal(web.ownerDecision,'REVIEW_REQUIRED');
  assert.ok(r.prs.every(p=>p.mergeAuthorized===false && p.productionAcceptance==='NOT_RUN'));
});

test('new overlap with owner or merged main is surfaced and never considered merge authorization', () => {
  const data=clone();
  find(data,1123).paths.push(data.owners[1096].paths[0]);
  find(data,1127).paths.push(data.mergedPaths[0]);
  const r=audit(data);
  assert.equal(r.prs.find(p=>p.number===1123).samePathOwner[0].owners[0],1096);
  assert.deepEqual(r.prs.find(p=>p.number===1127).samePathMain,[data.mergedPaths[0]]);
  assert.equal(r.mergeAuthorized,false);
});

test('exact same changed source path in two PRs blocks standalone candidate', () => {
  const data=clone();
  find(data,1127).paths.push(find(data,1123).paths[0]);
  const r=audit(data);
  assert.equal(r.prs.find(p=>p.number===1127).samePathSource.length,1);
  assert.equal(r.prs.find(p=>p.number===1123).sourceReviewCandidate,false);
});

test('reversed issue event sequence or missing historical issue state fails closed', () => {
  const data=clone();
  data.incident.reopened.createdAt='2026-11-08T12:14:40Z';
  assert.throws(()=>incidentGate(data.incident),/chronology/);
  const missing=clone();delete missing.incident.closed.id;
  assert.throws(()=>incidentGate(missing.incident),/missing/);
});

test('partial, duplicate, closed, non-Draft and stale owner input fail closed', () => {
  const short=clone();short.prs.pop();assert.throws(()=>audit(short),/incomplete/);
  const dup=clone();dup.prs[1].number=dup.prs[0].number;assert.throws(()=>audit(dup),/Duplicate/);
  const closed=clone();find(closed,1127).state='closed';assert.throws(()=>audit(closed),/open Draft/);
  const ready=clone();find(ready,1123).draft=false;assert.throws(()=>audit(ready),/open Draft/);
  const owner=clone();owner.owners[1096].paths=[];assert.throws(()=>audit(owner),/Owner provenance/);
});

test('shortlist is conditional source-only; report never offers automatic merge', () => {
  const r=audit(fixture);
  assert.deepEqual(r.reviewOnlyShortlist,[1127,1123,1119]);
  const md=markdown(fixture);
  assert.ok(md.includes('Merge allowed: NO'));
  assert.ok(md.includes('Physical/Windows/provider acceptance: NOT_RUN'));
});

test('actual 42 PR descriptions and 139 commit messages expose five negated closing triggers', () => {
  const result=metadataAudit(meta,fixture.prs);
  assert.equal(result.scannedPrs,42);
  assert.equal(result.scannedCommitMessages,139);
  assert.deepEqual(result.riskyNumbers,[1100,1101,1115,1121,1122]);
  assert.ok(result.risky.every(w=>w.field==='body'));
  assert.deepEqual(result.risky.map(w=>w.prNumber).sort((a,b)=>a-b),[1100,1101,1115,1121,1122]);
});

test('one PR moved since metadata scan: no inherited clean-metadata verdict', () => {
  const r=metadataAudit(meta,fixture.prs);
  assert.deepEqual(r.headMovedSinceMetadataScan,[1106]);
  assert.equal(r.noMergeWhileWarningUnresolved,true);
});

test('five risky PRs excluded from source-only triage until metadata is corrected', () => {
  const r=audit(fixture,meta);
  assert.deepEqual(r.metadata.riskyNumbers,[1100,1101,1115,1121,1122]);
  for(const n of r.metadata.riskyNumbers){
    const p=r.prs.find(p=>p.number===n);
    assert.equal(p.metadataClosingWarning,true);
    assert.equal(p.sourceReviewCandidate,false);
  }
  assert.ok(markdown(fixture,meta).includes('#1100, #1101, #1115, #1121, #1122'));
});

test('partial, duplicate or fabricated metadata scan must not be treated as cleared', () => {
  const short=structuredClone(meta);short.prs.pop();
  assert.throws(()=>metadataAudit(short,fixture.prs),/42 source PRs/);
  const dup=structuredClone(meta);dup.prs[1].number=dup.prs[0].number;
  assert.throws(()=>metadataAudit(dup,fixture.prs),/Duplicate/);
  const fake=structuredClone(meta);fake.prs.find(p=>p.number===1122).findings[0].excerpt='Issue #539 remains open';
  assert.throws(()=>metadataAudit(fake,fixture.prs),/Unverifiable/);
});
