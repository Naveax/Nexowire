import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateElasticScale, type ElasticScaleScenario,
} from '../src/ops/scale-elastic-capacity-model.js';

const one:ElasticScaleScenario={
  activeUsers:1,
  logicalCallsPerUserPerDay:10_000_000,
  workerRequestsPerLogicalCall:1,
  d1RowsReadPerLogicalCall:1,
  d1RowsWrittenPerLogicalCall:1,
  daysInMonth:30,
  retryBasisPoints:0,
  peakMultiplier:10,
  planDailyCallLimit:1000,
};

test('1 user 10M/day creates 116 average and 1158 tenfold peak ingress RPS',()=>{
  const x=estimateElasticScale(one);
  assert.equal(x.dailyLogicalCalls,10_000_000n);
  assert.equal(x.dailyWorkerRequests,10_000_000n);
  assert.equal(x.avgWorkerRequestsPerSecondCeiling,116n);
  assert.equal(x.peakWorkerRequestsPerSecondCeiling,1158n);
  assert.equal(x.peakLogicalCallsPerUserSecondCeiling,1158n);
  assert.equal(x.exceedsUserPlan,true);
});

test('Paid modeled 10M/day one user incurs $92 Worker and $250 D1 row-write usage',()=>{
  const x=estimateElasticScale(one);
  assert.equal(x.monthlyWorkerRequests,300_000_000n);
  assert.equal(x.monthlyD1RowsWritten,300_000_000n);
  assert.equal(x.modeledWorkerCostUSD,'$92.00');
  assert.equal(x.modeledD1RowCostUSD,'$250.00');
  assert.equal(x.modeledPartialCostUSD,'$342.00');
});

test('two Worker requests per tool raises bill but not logical or D1 quota',()=>{
  const x=estimateElasticScale({...one,workerRequestsPerLogicalCall:2});
  assert.equal(x.monthlyWorkerRequests,600_000_000n);
  assert.equal(x.modeledWorkerCostUSD,'$182.00');
  assert.equal(x.modeledD1RowCostUSD,'$250.00');
  assert.equal(x.modeledPartialCostUSD,'$432.00');
  assert.equal(x.peakWorkerRequestsPerSecondCeiling,2315n);
});

test('1000 users at 1000 calls/day fit the included D1 write allocation',()=>{
  const x=estimateElasticScale({
    ...one,activeUsers:1000,logicalCallsPerUserPerDay:1000,
  });
  assert.equal(x.dailyLogicalCalls,1_000_000n);
  assert.equal(x.monthlyWorkerRequests,30_000_000n);
  assert.equal(x.modeledPartialCostUSD,'$11.00');
  assert.equal(x.exceedsUserPlan,false);
});

test('100000 daily active users at 1000 calls/day are expensive, not free',()=>{
  const x=estimateElasticScale({
    ...one,activeUsers:100000,logicalCallsPerUserPerDay:1000,
  });
  assert.equal(x.dailyLogicalCalls,100_000_000n);
  assert.equal(x.modeledWorkerCostUSD,'$902.00');
  assert.equal(x.modeledD1RowCostUSD,'$2950.00');
  assert.equal(x.modeledPartialCostUSD,'$3852.00');
});

test('user subscription changes the entitlement, not modeled compute demand',()=>{
  const free=estimateElasticScale({...one,logicalCallsPerUserPerDay:1500,planDailyCallLimit:1000});
  const paid=estimateElasticScale({...one,logicalCallsPerUserPerDay:1500,planDailyCallLimit:5000});
  assert.equal(free.exceedsUserPlan,true);
  assert.equal(paid.exceedsUserPlan,false);
  assert.equal(free.dailyWorkerRequests,paid.dailyWorkerRequests);
  assert.equal(free.monthlyD1RowsWritten,paid.monthlyD1RowsWritten);
  assert.equal(free.modeledPartialCostUSD,paid.modeledPartialCostUSD);
});

test('retry overhead is counted separately and cannot grant extra tool calls',()=>{
  const x=estimateElasticScale({...one,retryBasisPoints:500});
  assert.equal(x.dailyLogicalCalls,10_000_000n);
  assert.equal(x.dailyWorkerRequests,10_500_000n);
  assert.equal(x.exceedsUserPlan,true);
  assert.equal(x.monthlyD1RowsWritten,300_000_000n);
});

test('rounds fractional cents only when reporting and rejects invalid assumptions',()=>{
  const few=estimateElasticScale({...one,activeUsers:0});
  assert.equal(few.modeledPartialCostUSD,'$5.00');
  for (const bad of [
    {workerRequestsPerLogicalCall:0},
    {activeUsers:-1},
    {logicalCallsPerUserPerDay:1.1},
    {daysInMonth:32},
    {daysInMonth:0},
    {retryBasisPoints:10001},
    {peakMultiplier:0},
    {peakMultiplier:1001},
    {d1RowsWrittenPerLogicalCall:Number.MAX_SAFE_INTEGER+1},
  ])assert.throws(()=>estimateElasticScale({...one,...bad}));
});

test('high request inputs use bigint without silently overflowing JavaScript number precision',()=>{
  const x=estimateElasticScale({...one,activeUsers:100_000_000});
  assert.equal(x.dailyLogicalCalls,1_000_000_000_000_000n);
  assert.equal(x.monthlyWorkerRequests,30_000_000_000_000_000n);
});
