/** T-252: offline meter evidence distinguishes observed zero from absent evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareS5CloudflareWindows,type S5CloudflareSnapshot,
} from '../../../src/ops/scale-s5-provider-meter-evidence.js';
import {
  reconcileS5ResourceCounters,type S5ObservedCounters,
} from '../../../src/ops/scale-s5-resource-reconciliation.js';
import {ScaleTransportMetrics} from '../../../src/ops/scale-transport-metrics.js';

const before=():S5CloudflareSnapshot=>({
  source:'operator-export-unverified',accountRef:'synthetic-account-001',
  workerRef:'synthetic-worker-001',d1Ref:'synthetic-d1-001',
  durableObjectNamespaceRef:'synthetic-do-001',
  capturedAtUtc:'2026-10-19T10:00:00Z',
  workerRequests:0,workerCpuMs:0,d1RowsRead:0,d1RowsWritten:0,
  doRequestUnits:0,doDurationGbSeconds:0,
});
const after=(start:S5CloudflareSnapshot):S5CloudflareSnapshot=>({
  ...start,capturedAtUtc:'2026-10-19T10:00:10Z',
});

test('T-252 an observed zero delta remains numeric 0, not UNKNOWN',()=>{
  const a=before();
  const r=compareS5CloudflareWindows(a,after(a),1);
  for(const metric of ['workerRequests','workerCpuMs','d1RowsRead','d1RowsWritten',
    'doRequestUnits','doDurationGbSeconds'] as const){
    assert.equal(r[metric],0,metric);
  }
  assert.equal(r.workerRequestsPerQuotaReservation,0);
  // Even a reported zero meter delta is not independently authenticated billing.
  assert.equal(r.providerAuthenticated,false);
  assert.equal(r.providerCostUsd,null);
  assert.equal(r.zeroIncrementalInvoiceProven,false);
});

test('T-252 missing source values stay UNKNOWN even if the other sample is zero',()=>{
  const a={...before(),workerRequests:null,workerCpuMs:null,d1RowsRead:null,
    d1RowsWritten:null,doRequestUnits:null,doDurationGbSeconds:null};
  const b={...after(a),workerRequests:0,workerCpuMs:0,d1RowsRead:0,
    d1RowsWritten:0,doRequestUnits:0,doDurationGbSeconds:0};
  const r=compareS5CloudflareWindows(a,b,1);
  for(const metric of ['workerRequests','workerCpuMs','d1RowsRead','d1RowsWritten',
    'doRequestUnits','doDurationGbSeconds'] as const){
    assert.equal(r[metric],null,metric);
  }
  assert.equal(r.workerRequestsPerQuotaReservation,null);
  assert.equal(r.zeroIncrementalInvoiceProven,false);
  assert.ok(r.warnings.some(x=>/unknown, never zero/.test(x)));
});

test('T-252 zero reservation denominator is UNKNOWN, not 0 requests per reservation',()=>{
  const a=before();
  const r=compareS5CloudflareWindows(a,after(a),0);
  assert.equal(r.workerRequests,0);
  assert.equal(r.workerRequestsPerQuotaReservation,null);
  assert.equal(r.workerRequestsPerVerifiedNativeCompletion,null);
});

const observedZeros=():S5ObservedCounters=>({
  origin:'synthetic-fixture',intervalSeconds:10,quotaReservations:0,
  nativeCompletedReported:0,nativeFailedReported:0,nativeUnknownReported:0,
  workerHttpRequests:0,d1RowsRead:0,d1RowsWritten:0,
  durableObjectRequestUnits:0,durableObjectDurationGbSeconds:0,
  relayEgressBytes:0,wssPeakConnections:0,reconnects:0,
  cpuMeanPercent:0,rssPeakBytes:0,
});

test('T-252 zero synthetic counters cannot become observed native/provider success',()=>{
  const r=reconcileS5ResourceCounters(observedZeros());
  assert.equal(r.perSecond.quotaReservations,0);
  assert.equal(r.perSecond.nativeCompletionsReported,0);
  assert.equal(r.perSecond.verifiedNativeCompletions,null);
  assert.equal(r.workerRequestsPerReservation,null);
  assert.equal(r.workerRequestsPerReportedCompletion,null);
  assert.equal(r.d1WritesPerReservation,null);
  assert.equal(r.d1ReadsPerReservation,null);
  assert.equal(r.potentiallyUnfinishedReservations,0);
  assert.equal(r.providerMetricsAuthenticated,false);
  assert.equal(r.zeroExtraCloudBillProven,false);
  assert.ok(r.notes.some(x=>/UNKNOWN, not success/.test(x)));
});

test('T-252 default in-memory transport zeros are not provider observation evidence',()=>{
  const optional=new ScaleTransportMetrics();
  const unobserved=optional.snapshot();
  // The optional in-memory source has no presence bit; zeros alone are not a
  // safe input for an authenticated provider report or zero-invoice claim.
  assert.equal(unobserved['agent.connections'].events,0);
  optional.record('agent.connections',0,0);
  assert.deepEqual(optional.snapshot(),unobserved);
  assert.equal(unobserved['relay.auth_denials'].bytes,0);
});
