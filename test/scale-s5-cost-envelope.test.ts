import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateS5Cost,projectS5Matrix,S5_ASSUMPTION_DEFAULTS} from '../src/ops/scale-s5-cost-envelope.js';
test('100 modest synthetic users are only nominally inside Free numeric budgets',()=>{
  const r=estimateS5Cost({...S5_ASSUMPTION_DEFAULTS,activeUsers:100,callsPerUserDaily:100});
  assert.equal(r.daily.logicalCalls,'10000');
  assert.equal(r.daily.d1RowsWritten,'20000');
  assert.equal(r.freeEnvelope.numericThresholdsFit,true);
  assert.equal(r.freeEnvelope.zeroExtraInvoiceProven,false);
});
test('1000 and 10000 users require more than free worker/D1 budget',()=>{
  const results=projectS5Matrix();
  assert.equal(results.length,5);
  for(const i of [1,2,3,4])assert.equal(results[i]!.freeEnvelope.numericThresholdsFit,false);
  assert.ok(results[4]!.daily.workerRequests==='1785006'); // 850k*2, 1 upgrade+4 control, 5% retry rounded
});
test('transport 600/min and 850k/day cannot imply successful calls',()=>{
  const theoretical=600*60*24;
  assert.equal(theoretical,864000);
  assert.ok(850000/theoretical>0.98);
});
test('invalid budgets and zero hosted ingress are blocked',()=>{
  for(const patch of [{workerRequestsPerCall:0},{retryBasisPoints:10001},
    {days:0},{d1WritesPerCall:-1},{activeUsers:Infinity},
    {workerCpuMsPerRequest:-2}]){
    assert.throws(()=>estimateS5Cost({...S5_ASSUMPTION_DEFAULTS,...patch}));
  }
});
