import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptSoak,type SoakEvidence} from '../scripts/s5-soak-acceptance.js';
const base=():SoakEvidence=>({
  sourceCommit:'a'.repeat(40),environment:'authorized-staging',
  startedAtUtc:'2026-10-18T00:00:00Z',endedAtUtc:'2026-10-18T00:00:30Z',
  samples:[],providerCountersVerified:false,executionCompletionCountersVerified:false,
  ownerApprovalRecorded:false,outageOrSpendingIncident:false,
});
test('S5 30-second or fabricated 24h proof can never pass 24h metadata gate',()=>{
  const b=base();
  const r=acceptSoak(b);
  assert.equal(r.accepted,false);
  assert.equal(r.productionAccepted,false);
  assert.ok(r.reasons.includes('less than 24 hours elapsed'));
  assert.ok(r.reasons.includes('missing or oversized minute interval samples'));
  assert.equal(acceptSoak({...b,endedAtUtc:'2026-10-19T00:00:00Z'}).accepted,false);
});
const complete=():SoakEvidence=>{
  const b=base();
  b.endedAtUtc='2026-10-19T00:00:00Z';
  b.ownerApprovalRecorded=true;
  b.ownerApprovalReference='staging-approval-20261018';
  b.providerCountersVerified=true;
  b.providerCountersArtifactSha256='b'.repeat(64);
  b.executionCompletionCountersVerified=true;
  b.executionCountersArtifactSha256='c'.repeat(64);
  b.samples=Array.from({length:1441},(_,i)=>({
    atUtc:new Date(Date.parse(b.startedAtUtc)+i*60000).toISOString(),
    connections:16,rpcCompleted:i,p99Ms:90,errorFraction:0,
    cpuPercent:12,rssBytes:50000000,
  }));
  return b;
};
test('S5 structurally complete fixture passes metadata, never production acceptance',()=>{
  const result=acceptSoak(complete());
  assert.deepEqual(result.reasons,[]);
  assert.equal(result.accepted,true);
  assert.equal(result.productionAccepted,false);
});
test('S5 fabricated duplicate timestamps, counter resets and gaps fail closed',()=>{
  const dups=complete();
  dups.samples[100]!.atUtc=dups.samples[99]!.atUtc;
  assert.ok(acceptSoak(dups).reasons.some(x=>x.includes('duplicate or out-of-order')));
  const regression=complete();
  regression.samples[200]!.rpcCompleted=0;
  assert.ok(acceptSoak(regression).reasons.some(x=>x.includes('regressing')));
  const gap=complete();
  gap.samples=gap.samples.map((s,i)=>i<600?s:{...s,
    atUtc:new Date(Date.parse(s.atUtc)+10*60000).toISOString()});
  assert.ok(acceptSoak(gap).reasons.includes('more than 2-minute sample gap'));
  const noProgress=complete();
  noProgress.samples.forEach(x=>x.rpcCompleted=0);
  assert.ok(acceptSoak(noProgress).reasons.includes('no reported completed native tool'));
});
test('S5 invalid negative counters / hashless provider claims are rejected',()=>{
  const invalid=complete();
  invalid.samples[3]!.rssBytes=-1;
  assert.ok(acceptSoak(invalid).reasons.includes('invalid sample'));
  const forged=complete();
  forged.providerCountersArtifactSha256=undefined;
  assert.ok(acceptSoak(forged).reasons.includes('missing content-addressed provider counters'));
});
