import test from 'node:test';
import assert from 'node:assert/strict';
import {compareS5CloudflareWindows,type S5CloudflareSnapshot}
  from '../src/ops/scale-s5-provider-meter-evidence.js';
const start=():S5CloudflareSnapshot=>({
  source:'operator-export-unverified',accountRef:'authorized-staging-account',
  workerRef:'staging-worker-001',d1Ref:'staging-d1-001',
  durableObjectNamespaceRef:'staging-do-001',
  capturedAtUtc:'2026-10-19T10:00:00Z',
  workerRequests:1000,workerCpuMs:300.12,
  d1RowsRead:4000,d1RowsWritten:2000,
  doRequestUnits:50,doDurationGbSeconds:7.25,
});
test('Cloudflare snapshots return counter DELTAS, no verified native completion or bill',()=>{
  const a=start();
  const b={...a,capturedAtUtc:'2026-10-19T10:01:00Z',
    workerRequests:1300,workerCpuMs:320.87,
    d1RowsRead:4650,d1RowsWritten:2130,
    doRequestUnits:66,doDurationGbSeconds:9.75};
  const r=compareS5CloudflareWindows(a,b,100);
  assert.equal(r.workerRequests,300);
  assert.equal(r.workerCpuMs,20.75);
  assert.equal(r.d1RowsRead,650);assert.equal(r.d1RowsWritten,130);
  assert.equal(r.doRequestUnits,16);assert.equal(r.doDurationGbSeconds,2.5);
  assert.equal(r.workerRequestsPerQuotaReservation,3);
  assert.equal(r.workerRequestsPerVerifiedNativeCompletion,null);
  assert.equal(r.providerAuthenticated,false);
  assert.equal(r.providerCostUsd,null);
  assert.equal(r.zeroIncrementalInvoiceProven,false);
});
test('Unknown DO/D1 data stay null and never represent a zero bill',()=>{
  const a={...start(),d1Ref:null,durableObjectNamespaceRef:null,
    d1RowsRead:null,d1RowsWritten:null,doRequestUnits:null,doDurationGbSeconds:null};
  const b={...a,capturedAtUtc:'2026-10-19T10:00:10Z',workerRequests:1001};
  const r=compareS5CloudflareWindows(a,b,null);
  assert.equal(r.d1RowsRead,null);
  assert.equal(r.doDurationGbSeconds,null);
  assert.equal(r.workerRequestsPerQuotaReservation,null);
  assert.equal(r.zeroIncrementalInvoiceProven,false);
});
test('Cross resource, backwards clock, decreasing and invalid meter counters fail',()=>{
  const a=start();
  const b={...a,capturedAtUtc:'2026-10-19T10:01:00Z',workerRequests:1001};
  for(const x of [
    {...b,accountRef:'other-staging-account'},
    {...b,workerRef:'other-worker'},
    {...b,capturedAtUtc:'2026-10-19T09:00:00Z'},
    {...b,workerRequests:999},
    {...b,d1RowsWritten:1999},
    {...b,durableObjectNamespaceRef:null},
    {...b,doDurationGbSeconds:Number.NaN},
  ])assert.throws(()=>compareS5CloudflareWindows(a,x,10));
  assert.throws(()=>compareS5CloudflareWindows(a,b,-1));
  assert.throws(()=>compareS5CloudflareWindows(a,b,1.5));
});
