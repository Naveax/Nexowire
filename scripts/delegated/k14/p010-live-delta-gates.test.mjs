import test from 'node:test';
import assert from 'node:assert/strict';
import {auditLiveDelta,markdownLiveDelta} from './p010-live-delta-gates.mjs';
const sha=n=>String(n).repeat(40);
const old={capturedAt:'2026-11-08T00:00:00Z',prs:Array.from({length:59},(_,i)=>({number:1001+i,head:sha('a')}))};
const make=()=>({capturedAt:'2026-11-15T00:00:00Z',main:sha('b'),forkMain:sha('b'),
  prs:old.prs.map(x=>({...x,state:'open',draft:true})),
  owners:{1068:{head:sha('c'),paths:['web/app.js']},1096:{head:sha('d'),paths:['src/core/test.ts']},1160:{head:sha('e'),paths:['.github/workflows/ci.yml']}},
  k14:{number:1153,head:sha('a'),paths:['scripts/delegated/k14/x.mjs']},runObservations:[]});
// Synthetic 59-PR test cohort makes #1153 a member of the current inventory.
old.prs[58]={number:1153,head:sha('a')};
const run=()=>({number:1153,head:sha('a'),runId:123,status:'completed',conclusion:'success'});
test('59 exact PR heads and non-overlapping owners, never imply merge readiness',()=>{
  const s=make();s.prs[58]={number:1153,head:sha('a'),state:'open',draft:true};s.runObservations=[run()];
  const r=auditLiveDelta(old,s);
  assert.equal(r.scanned,59);assert.equal(r.runsChecked,1);assert.equal(r.ciCoverageComplete,false);
  assert.equal(r.hasSourceOverlaps,false);assert.equal(r.mergeAuthorized,false);
  assert.equal(r.nestedExecution,'NOT_VERIFIED');assert.equal(r.physicalAcceptance,'NOT_RUN');
});
test('moving PR HEAD is reported and never inherits old CI',()=>{
  const s=make();s.prs[58]={number:1153,head:sha('f'),state:'open',draft:true};
  s.k14.head=sha('f');s.runObservations=[run()];
  assert.throws(()=>auditLiveDelta(old,s),/stale run HEAD/);
  s.runObservations=[];assert.deepEqual(auditLiveDelta(old,s).changed,[1153]);
});
test('duplicate PR, closed PR, wrong K14 HEAD and missing owner paths fail closed',()=>{
  for(const mutate of [s=>s.prs[0].number=1002,s=>s.prs[0].state='closed',
    s=>s.k14.head=sha('f'),s=>s.owners[1160].paths=[]]) {
    const s=make();s.prs[58]={number:1153,head:sha('a'),state:'open',draft:true};mutate(s);
    assert.throws(()=>auditLiveDelta(old,s));
  }
});
test('owner overlap is surfaced but not treated as permission to merge',()=>{
  const s=make();s.prs[58]={number:1153,head:sha('a'),state:'open',draft:true};
  s.owners[1160].paths.push('scripts/delegated/k14/x.mjs');
  const r=auditLiveDelta(old,s);assert.deepEqual(r.ownerCollisions[1160],['scripts/delegated/k14/x.mjs']);
  assert.equal(r.hasSourceOverlaps,true);assert.equal(r.mergeAuthorized,false);
});
test('zero-job and queue states cannot appear as success; empty run ID is invalid',()=>{
  const s=make();s.prs[58]={number:1153,head:sha('a'),state:'open',draft:true};
  s.runObservations=[{...run(),runId:null,status:'NO_RUN_OBSERVED',conclusion:null}];
  assert.equal(auditLiveDelta(old,s).runs[0].conclusion,null);
  s.runObservations=[{...run(),runId:null,status:'completed'}];
  assert.throws(()=>auditLiveDelta(old,s),/invalid run observation/);
});
test('offline report labels observations and does not claim full discovery',()=>{
  const s=make();s.prs[58]={number:1153,head:sha('a'),state:'open',draft:true};s.runObservations=[run()];
  const md=markdownLiveDelta(old,s);assert.match(md,/1\/59/);assert.match(md,/No owner authorization/);
});
