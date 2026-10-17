import test from 'node:test';
import assert from 'node:assert/strict';
import {runLocalOwnerQuotaBenchmark} from '../scripts/bench-s5-owner-quota-local.js';

test('local owner quota file database records 24 admissions and 5 idempotent replays',async()=>{
  const result=await runLocalOwnerQuotaBenchmark({
    requests:24,accounts:3,replayChecks:5,
  });
  assert.equal(result.kind,'local-owner-sqlite-only');
  assert.equal(result.accepted,24);
  assert.equal(result.rejected,0);
  assert.equal(result.replayDuplicate,5);
  assert.equal(result.ledgerRows,24);
  assert.equal(result.dailyUsed,24);
  assert.equal(result.requests,24);
  assert.equal(result.accounts,3);
  assert.ok(result.reservationsPerSecond>0);
  assert.ok(result.latencyMs.p95>=result.latencyMs.p50);
  assert.ok(result.latencyMs.p99>=result.latencyMs.p95);
  assert.ok(result.databaseBytes>0);
  assert.ok(result.constraints.some(x=>x.includes('NOT simultaneous writers')));
});
test('single-account throughput does not create another account allowance',async()=>{
  const result=await runLocalOwnerQuotaBenchmark({
    requests:17,accounts:1,replayChecks:17,
  });
  assert.equal(result.accepted,17);
  assert.equal(result.replayDuplicate,17);
  assert.equal(result.dailyUsed,17);
});
test('benchmark refuses huge workloads, invalid accounts and unknown inputs',async()=>{
  for(const options of [
    {requests:0,accounts:1},{requests:10001,accounts:1},
    {requests:20,accounts:0},{requests:20,accounts:51},
    {requests:4,accounts:5},{requests:7,accounts:2,replayChecks:101},
    {requests:NaN,accounts:1},
  ]){
    await assert.rejects(runLocalOwnerQuotaBenchmark(options));
  }
});
