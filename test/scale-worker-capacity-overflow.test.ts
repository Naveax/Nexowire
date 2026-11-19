import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateScaleWorkerDemand,
  maxActiveUsersUnderBudget,
  type ScaleWorkerDemand,
} from '../src/ops/scale-worker-capacity-model.js';

const base:ScaleWorkerDemand={
  activeUsers:0,hostedToolCallsPerUserPerDay:10_000,
  authWorkerRequestsPerTool:10_000,chargeWorkerRequestsPerTool:0,
  otherWorkerRequestsPerUserPerDay:0,fixedWorkerRequestsPerDay:0,
  retryPermille:0,workerRequestBudgetPerDay:Number.MAX_SAFE_INTEGER,
};

test('max users remains exact when search midpoints overflow safe arithmetic',()=>{
  const expected=Number(BigInt(Number.MAX_SAFE_INTEGER)/100_000_000n);
  assert.equal(expected,90_071_992);
  assert.equal(maxActiveUsersUnderBudget(base),expected);
  assert.equal(estimateScaleWorkerDemand({...base,activeUsers:expected}).withinBudget,true);
  assert.throws(
    ()=>estimateScaleWorkerDemand({...base,activeUsers:expected+1}),
    /capacity result must be a non-negative safe integer/,
  );
});

test('a single user exceeding safe numeric demand has zero affordable capacity',()=>{
  assert.equal(maxActiveUsersUnderBudget({
    ...base,workerRequestBudgetPerDay:100_000,
    hostedToolCallsPerUserPerDay:Number.MAX_SAFE_INTEGER,
    authWorkerRequestsPerTool:2,
  }),0);
});

test('input validation remains strict while capacity overflow is treated as over-budget',()=>{
  assert.throws(()=>maxActiveUsersUnderBudget({
    ...base,retryPermille:1001,
  }),/retryPermille must be <= 1000/);
  assert.throws(()=>maxActiveUsersUnderBudget({
    ...base,workerRequestBudgetPerDay:-1,
  }),/workerRequestBudgetPerDay must be a non-negative safe integer/);
  assert.equal(maxActiveUsersUnderBudget({
    ...base,workerRequestBudgetPerDay:0,
    hostedToolCallsPerUserPerDay:0,
    authWorkerRequestsPerTool:0,
  }),Number.MAX_SAFE_INTEGER);
});
