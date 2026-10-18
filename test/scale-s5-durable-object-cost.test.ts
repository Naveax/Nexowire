import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateS5DurableObject,S5_DO_EXAMPLES} from '../src/ops/scale-s5-durable-object-cost.js';
test('S5 DO hibernation can make idle duration zero, but connection and message requests remain',()=>{
  const r=estimateS5DurableObject(S5_DO_EXAMPLES.hibernatingOneDo);
  assert.equal(r.daily.durationGbSeconds,'0');
  assert.equal(r.daily.webSocketUpgrades,'100');
  assert.equal(r.daily.inboundMessages,'20500');
  assert.equal(r.daily.modeledChargedDoRequests,'1125');
  assert.equal(r.freeNumericBudget.numericThresholdsFit,true);
  assert.equal(r.freeNumericBudget.zeroExtraInvoiceProven,false);
});
test('Two nonhibernating DOs exhaust free 13000 GB-s/day even at low requests',()=>{
  const one=estimateS5DurableObject(S5_DO_EXAMPLES.oneDoAlwaysAwake);
  const two=estimateS5DurableObject(S5_DO_EXAMPLES.twoDoAlwaysAwake);
  assert.equal(one.daily.durationGbSeconds,'10800');
  assert.equal(one.freeNumericBudget.numericThresholdsFit,true);
  assert.equal(two.daily.durationGbSeconds,'21600');
  assert.equal(two.freeNumericBudget.numericThresholdsFit,false);
  assert.ok(two.paidPartialUsd.duration>one.paidPartialUsd.duration);
});
test('S5 DO cost rejects impossible or overflowed WSS assumptions',()=>{
  for(const patch of [{activeUsers:-1},{days:32},{connectedSocketsPerUser:0},
    {awakeSecondsPerDoInstanceDaily:86401},{activeUsers:Number.POSITIVE_INFINITY},
    {activeUsers:10000000,callsPerUserDaily:850000,extraDoRpcSessionsPerCall:100}]){
    assert.throws(()=>estimateS5DurableObject({...S5_DO_EXAMPLES.oneDoAlwaysAwake,...patch}));
  }
});
