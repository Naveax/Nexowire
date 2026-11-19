import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeS5ScenarioResults} from '../../scripts/report-s5-measured-scenarios.js';
import type {S5LoadResult} from '../../scripts/bench-s5-loopback-ws-capacity.js';

const fixture=():S5LoadResult=>({
  kind:'SYNTHETIC_LOOPBACK_WS_OWNER_SQLITE',
  clients:2,mode:'isolated',callsPerClient:3,
  sockets:{connected:2,peak:2,closed:2},
  rpc:{attempted:6,reserved:2,duplicate:1,rateLimited:1,
    backpressure:1,other:1,peakInFlight:1,peakQueue:1,perSecond:2},
  latencyMs:{p50:1,p95:2,p99:3,max:3},
  cpuMs:{user:1,system:0},
  memoryBytes:{rssStart:1024,rssPeak:2048,rssEnd:2048},
  ioBytes:{sqlite:4096,wal:0,received:100,sent:100},
  fairness:{jainIndex:0.8,minUserSuccess:0,maxUserSuccess:2},
  ledger:{rows:2,dailyUsed:2,toolExecutions:0},
  elapsedMs:1000,constraints:['synthetic, not hosted acceptance'],
});

test('S5 report accepts exactly partitioned attempted RPCs without claiming provider capacity',()=>{
  const result=summarizeS5ScenarioResults([fixture()]);
  assert.equal(result.measurementClassification,'LOCAL_SYNTHETIC_ONLY');
  assert.equal(result.capacityEstimate,null);
  assert.equal(result.providerCapacityProven,false);
  assert.equal(result.scenarios[0]?.acceptedReservations,2);
});

test('S5 report rejects missing and double-counted outcome categories',()=>{
  for(const patch of [
    {attempted:5},
    {attempted:7},
    {reserved:3},
    {duplicate:2},
    {rateLimited:2},
    {backpressure:2},
    {other:2},
  ]){
    assert.throws(()=>summarizeS5ScenarioResults([{
      ...fixture(),rpc:{...fixture().rpc,...patch},
    }]),/Unbalanced synthetic RPC outcomes/);
  }
});

test('S5 report rejects unsafe and non-integer terminal counters before aggregating',()=>{
  for(const field of ['reserved','duplicate','rateLimited','backpressure','other'] as const){
    for(const invalid of [Number.NaN,Infinity,-1,1.2,Number.MAX_SAFE_INTEGER+1]){
      const sample=fixture();
      assert.throws(()=>summarizeS5ScenarioResults([{
        ...sample,rpc:{...sample.rpc,[field]:invalid},
      }]),/Invalid or non-monotonic scenario measurement|Invalid nonfinite scenario value/);
    }
  }
});

test('S5 report compares counter sum exactly at safe-integer boundaries',()=>{
  const sample=fixture();
  const attempted=Number.MAX_SAFE_INTEGER;
  assert.doesNotThrow(()=>summarizeS5ScenarioResults([{
    ...sample,rpc:{...sample.rpc,attempted,reserved:attempted,
      duplicate:0,rateLimited:0,backpressure:0,other:0},
  }]));
  assert.throws(()=>summarizeS5ScenarioResults([{
    ...sample,rpc:{...sample.rpc,attempted,reserved:attempted,
      duplicate:1,rateLimited:0,backpressure:0,other:0},
  }]),/Unbalanced synthetic RPC outcomes/);
});
