import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { audit, ciGate, discoveryForFile, REQUIRED_JOBS } from './p005-integration-gates.mjs';

const snapshot=JSON.parse(await readFile(new URL('../../../docs/delegated/integration-k14/p005-31-prs-20261108.json', import.meta.url),'utf8'));
const mutate=()=>structuredClone(snapshot);
const pr=(source,number)=>source.prs.find(p=>p.number===number);

test('current main is fast-forwarded one commit; 31 exact sources stay Draft, with 0 direct overlaps',()=>{
  const r=audit(snapshot);
  assert.equal(r.prs.length,31);
  assert.equal(r.synchronized,true);
  assert.equal(r.oldMainIsAncestor,true);
  assert.equal(r.prs.filter(p=>p.outdatedBase).length,31);
  assert.equal(r.prs.reduce((n,p)=>n+p.mainOverlap.length+p.ownerOverlap.length+p.crossPrOverlap.length,0),0);
  assert.equal(r.mergeAuthorized,false);
});

test('31 sources: 24 stable green jobs, four moving heads, three actual CI failures',()=>{
  const r=audit(snapshot);
  assert.deepEqual(r.counts,{GREEN_SOURCE_JOBS_ONLY:24,HEAD_MOVED_RECHECK:4,CI_FAILED:3});
  assert.deepEqual(r.prs.filter(p=>p.ci==='HEAD_MOVED_RECHECK').map(p=>p.number),[1100,1105,1109,1114]);
  assert.deepEqual(r.prs.filter(p=>p.ci==='CI_FAILED').map(p=>p.number),[1118,1120,1130]);
  assert.ok(r.prs.every(p=>p.mergeReady===false&&p.physicalAcceptance==='NOT_RUN'));
});

test('exact 7 jobs may be green while newly-added .mjs tests remain undiscovered',()=>{
  const r=audit(snapshot);
  for(const number of [1117,1123]){
    const p=r.prs.find(pr=>pr.number===number);
    assert.equal(p.ci,'GREEN_SOURCE_JOBS_ONLY');
    assert.equal(p.testProof,'NEW_TEST_EXECUTION_UNVERIFIED');
    assert.equal(p.tests.length,1);
    assert.equal(p.tests[0].proof,'NOT_REFERENCED_IN_CI');
  }
  assert.deepEqual(r.sourceCandidates,[]); // Never invent three verified candidates.
});

test('K07 changed test is explicitly invoked, but latest head moved and CI cannot be inherited',()=>{
  const r=audit(snapshot).prs.find(p=>p.number===1100);
  assert.equal(r.tests[0].proof,'EXPLICIT_CI_PATH');
  assert.equal(r.ci,'HEAD_MOVED_RECHECK');
  assert.equal(r.sourceCandidate,false);
});

test('K18 modified test is explicitly invoked while additional new TS test remains unverified',()=>{
  const r=audit(snapshot).prs.find(p=>p.number===1107);
  assert.deepEqual(r.tests.map(t=>t.proof),['NPM_GLOB_UNVERIFIED','EXPLICIT_CI_PATH']);
  assert.equal(r.testProof,'NEW_TEST_EXECUTION_UNVERIFIED');
});

test('explicit K20 CI wildcard is path-scoped; no generic .mjs auto-discovery',()=>{
  const p=snapshot.ciDiscovery.explicitTests;
  assert.equal(discoveryForFile('test/delegated/k20/new.test.mjs',p,snapshot.ciDiscovery.npmScript),'EXPLICIT_CI_PATH');
  assert.equal(discoveryForFile('test/delegated/k20/nested/new.test.mjs',p,snapshot.ciDiscovery.npmScript),'NOT_REFERENCED_IN_CI');
  assert.equal(discoveryForFile('scripts/delegated/k14/pagination-integrity.test.mjs',p,snapshot.ciDiscovery.npmScript),'NOT_REFERENCED_IN_CI');
});

test('a new green run for a prior SHA can never greenlight a moving PR head',()=>{
  const fixture=mutate();
  const p=pr(fixture,1100);
  p.run.head_sha=p.originalHead;
  p.run.status='completed';p.run.conclusion='success';
  p.totalJobs=7;p.jobs=REQUIRED_JOBS.map(name=>({name,run_id:p.run.id,head_sha:p.originalHead,status:'completed',conclusion:'success'}));
  assert.equal(ciGate(p),'HEAD_MOVED_RECHECK');
});

test('a misleading all-success run with one wrong-SHA job is rejected',()=>{
  const fixture=mutate();const p=pr(fixture,1117);
  p.jobs[0].head_sha='f'.repeat(40);
  assert.equal(ciGate(p),'JOB_FAILED_SKIPPED_OR_WRONG_SHA');
  p.jobs[0].head_sha=p.head;p.jobs[1].conclusion='skipped';
  assert.equal(ciGate(p),'JOB_FAILED_SKIPPED_OR_WRONG_SHA');
});

test('zero-job or wrong-head workflow never promotes source CI',()=>{
  const fixture=mutate();const p=pr(fixture,1123);
  p.jobs=[];
  assert.equal(ciGate(p),'JOB_PAGE_INCOMPLETE');
  p.run.head_sha='e'.repeat(40);
  assert.equal(ciGate(p),'RUN_HEAD_UNVERIFIED');
});

test('new main or active owner path overlap is visible but never inferred as a merge conflict',()=>{
  const fixture=mutate();pr(fixture,1117).files.push({path:'src/ops/scale-s5-cost-envelope.ts',blob:'b'.repeat(40),status:'modified'});
  pr(fixture,1123).files.push({path:fixture.owners.find(o=>o.number===1096).files[0].path,blob:'c'.repeat(40),status:'modified'});
  const r=audit(fixture);
  assert.deepEqual(r.prs.find(p=>p.number===1117).mainOverlap,['src/ops/scale-s5-cost-envelope.ts']);
  assert.equal(r.prs.find(p=>p.number===1123).ownerOverlap[0].owners.includes(1096),true);
  assert.equal(r.mergeAuthorized,false);
});

test('two source PRs changing one path are classified as overlap, not independently safe',()=>{
  const fixture=mutate();
  const shared=pr(fixture,1117).files[0];
  pr(fixture,1123).files.push({...shared});
  const r=audit(fixture);
  assert.ok(r.prs.find(p=>p.number===1117).crossPrOverlap.length);
  assert.ok(r.prs.find(p=>p.number===1123).crossPrOverlap.length);
  assert.equal(r.prs.find(p=>p.number===1123).sourceCandidate,false);
});

test('duplicate PR numbers or partial 31-PR pages fail closed',()=>{
  const fixture=mutate();fixture.prs.pop();
  assert.throws(()=>audit(fixture),/Incomplete P005/);
  const other=mutate();other.prs[1].number=other.prs[0].number;
  assert.throws(()=>audit(other),/duplicate source PR/);
});

test('positive explicit-CI-only source still requires owner review and is never mergeReady',()=>{
  const fixture=mutate();const p=pr(fixture,1107);
  p.files=p.files.filter(f=>f.path==='test/delegated/k18/s5-report-contract.test.ts');
  const r=audit(fixture).prs.find(x=>x.number===1107);
  assert.equal(r.testProof,'EXPLICIT_CI_STEPS_SUCCEEDED');
  assert.equal(r.sourceCandidate,true);
  assert.equal(r.mergeReady,false);
});
