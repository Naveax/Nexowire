import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptSoak,type SoakEvidence} from '../scripts/s5-soak-acceptance.js';
test('S5 30-second or fabricated 24h proof can never pass 24h soak gate',()=>{
  const stub:SoakEvidence={sourceCommit:'a'.repeat(40),environment:'authorized-staging',
    startedAtUtc:'2026-10-18T00:00:00Z',endedAtUtc:'2026-10-18T00:00:30Z',
    samples:[],providerCountersVerified:false,executionCompletionCountersVerified:false,
    ownerApprovalRecorded:false,outageOrSpendingIncident:false};
  const r=acceptSoak(stub);
  assert.equal(r.accepted,false);
  assert.ok(r.reasons.includes('less than 24 hours elapsed'));
  assert.ok(r.reasons.includes('missing minute interval samples'));
  const fake={...stub,endedAtUtc:'2026-10-19T00:00:00Z'};
  assert.equal(acceptSoak(fake).accepted,false);
});
