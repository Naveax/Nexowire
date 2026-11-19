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

test('zero-charge tool volume does not impose a phantom Worker request limit',()=>{
  const assumptions={
    ...base,workerRequestBudgetPerDay:1_000_000_000,
    hostedToolCallsPerUserPerDay:Number.MAX_SAFE_INTEGER,
    authWorkerRequestsPerTool:0,
    otherWorkerRequestsPerUserPerDay:939,
    fixedWorkerRequestsPerDay:2204,
    retryPermille:410,
  };
  const result=maxActiveUsersUnderBudget(assumptions);
  const requests=(users:bigint)=>{
    const baseRequests=2204n+939n*users;
    return baseRequests+(baseRequests*410n+999n)/1000n;
  };
  assert.equal(result,755_290);
  assert.ok(requests(BigInt(result))<=1_000_000_000n);
  assert.ok(requests(BigInt(result)+1n)>1_000_000_000n);
});

test('fixed overhead plus retries above budget returns zero at safe-integer edge',()=>{
  assert.equal(maxActiveUsersUnderBudget({
    ...base,workerRequestBudgetPerDay:Number.MAX_SAFE_INTEGER,
    fixedWorkerRequestsPerDay:Number.MAX_SAFE_INTEGER,
    retryPermille:1,
  }),0);
  assert.equal(maxActiveUsersUnderBudget({
    ...base,workerRequestBudgetPerDay:1_000,
    fixedWorkerRequestsPerDay:1_000,
    retryPermille:0,
  }),0);
});
