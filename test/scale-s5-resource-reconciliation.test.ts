import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileS5ResourceCounters,type S5ObservedCounters} from '../src/ops/scale-s5-resource-reconciliation.js';
const example=():S5ObservedCounters=>({
  origin:'synthetic-fixture',intervalSeconds:10,quotaReservations:500,
  nativeCompletedReported:0,nativeFailedReported:0,nativeUnknownReported:0,
  workerHttpRequests:1010,d1RowsRead:2000,d1RowsWritten:1000,
  durableObjectRequestUnits:100,durableObjectDurationGbSeconds:12,
  relayEgressBytes:200000,wssPeakConnections:128,reconnects:256,
  cpuMeanPercent:8,rssPeakBytes:120000000,
});
test('S5 500 quota reservations cannot claim any verified native completion',()=>{
  const r=reconcileS5ResourceCounters(example());
  assert.equal(r.perSecond.quotaReservations,50);
  assert.equal(r.perSecond.nativeCompletionsReported,0);
  assert.equal(r.perSecond.verifiedNativeCompletions,null);
  assert.equal(r.totals.verifiedNativeCompletions,0);
  assert.equal(r.potentiallyUnfinishedReservations,500);
  assert.equal(r.workerRequestsPerReservation,2.02);
  assert.equal(r.workerRequestsPerReportedCompletion,null);
  assert.equal(r.zeroExtraCloudBillProven,false);
});
test('S5 operator claimed 99 completions remain unverified, no auto promotion',()=>{
  const r=reconcileS5ResourceCounters({...example(),
    origin:'operator-unverified-export',nativeCompletedReported:99,
    nativeFailedReported:2,nativeUnknownReported:1});
  assert.equal(r.totals.nativeCompletedReported,99);
  assert.equal(r.totals.verifiedNativeCompletions,0);
  assert.equal(r.potentiallyUnfinishedReservations,398);
  assert.equal(r.providerMetricsAuthenticated,false);
});
test('S5 rejects more outcomes than reserved and forged counter values',()=>{
  for(const patch of [
    {nativeCompletedReported:501},{workerHttpRequests:-1},{intervalSeconds:0},
    {nativeUnknownReported:1000},{cpuMeanPercent:NaN},{sourceSha256:'fake'},
  ])assert.throws(()=>reconcileS5ResourceCounters({...example(),...patch}));
});
