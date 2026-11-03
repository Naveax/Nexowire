import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeS5ScenarioResults} from '../../../scripts/report-s5-measured-scenarios.js';
import type {S5LoadResult} from '../../../scripts/bench-s5-loopback-ws-capacity.js';

const sample=(clients=1,attempted=1,p99=3):S5LoadResult=>({
  kind:'SYNTHETIC_LOOPBACK_WS_OWNER_SQLITE',
  clients,mode:'isolated',callsPerClient:1,
  sockets:{connected:clients,peak:clients,closed:clients},
  rpc:{attempted,reserved:attempted,duplicate:0,rateLimited:0,
    backpressure:0,other:0,peakInFlight:1,peakQueue:1,perSecond:1},
  latencyMs:{p50:p99,p95:p99,p99,max:p99},
  cpuMs:{user:1,system:0},
  memoryBytes:{rssStart:1024,rssPeak:2048,rssEnd:2048},
  ioBytes:{sqlite:4096,wal:0,received:100,sent:100},
  fairness:{jainIndex:1,minUserSuccess:1,maxUserSuccess:1},
  ledger:{rows:attempted,dailyUsed:attempted,toolExecutions:0},
  elapsedMs:10,constraints:['synthetic only'],
});

test('T-107 empty sample set has no measured percentile or capacity estimate',()=>{
  const summary=summarizeS5ScenarioResults([]);
  assert.deepEqual(summary,{
    measurementClassification:'UNKNOWN',capacityEstimate:null,
    providerCapacityProven:false,scenarios:[],
  });
});

test('T-107 one latency sample has equal p50/p95/p99/max',()=>{
  const result=summarizeS5ScenarioResults([sample()]);
  assert.equal(result.measurementClassification,'LOCAL_SYNTHETIC_ONLY');
  assert.equal(result.scenarios[0]?.p99Ms,3);
  assert.equal(result.capacityEstimate,null);
  assert.equal(result.providerCapacityProven,false);
});

test('T-107 a one-sample percentile mismatch or empty sample count fails closed',()=>{
  const one=sample();
  assert.throws(()=>summarizeS5ScenarioResults([{
    ...one,latencyMs:{p50:1,p95:2,p99:3,max:3},
  }]),/single-sample/);
  assert.throws(()=>summarizeS5ScenarioResults([sample(1,0)]),/Missing latency/);
});

test('T-107 invalid percentile order and nonfinite values cannot become JSON zeroes',()=>{
  const one=sample(4,4);
  for(const latencyMs of [
    {p50:4,p95:2,p99:3,max:4},
    {p50:1,p95:2,p99:5,max:4},
    {p50:1,p95:2,p99:Infinity,max:Infinity},
    {p50:0,p95:0,p99:Number.NaN,max:3},
    {p50:-1,p95:1,p99:2,max:3},
  ])assert.throws(()=>summarizeS5ScenarioResults([{...one,latencyMs}]),/Invalid/);
});

test('T-108 output order stable and never claims provider capacity',()=>{
  const first=summarizeS5ScenarioResults([sample(100,2),sample(16,2)]);
  const second=summarizeS5ScenarioResults([sample(16,2),sample(100,2)]);
  assert.equal(JSON.stringify(first),JSON.stringify(second));
  assert.deepEqual(first.scenarios.map(x=>x.clients),[16,100]);
  assert.equal(first.capacityEstimate,null);
  assert.equal(first.providerCapacityProven,false);
});

test('T-108 duplicate scenarios and missing measurement fields are rejected',()=>{
  assert.throws(()=>summarizeS5ScenarioResults([sample(16),sample(16)]),/Duplicate/);
  assert.throws(()=>summarizeS5ScenarioResults([{...sample(),elapsedMs:NaN}]),/Invalid/);
  assert.throws(()=>summarizeS5ScenarioResults([{...sample(),
    memoryBytes:{rssStart:0,rssEnd:0,rssPeak:Infinity},
  }]),/Invalid/);
});

test('T-223 invalid nested JSON numbers are rejected instead of becoming null or zero',()=>{
  for(const value of [Number.NaN,Infinity,-Infinity]){
    const normal=sample(4,4);
    assert.throws(()=>summarizeS5ScenarioResults([{
      ...normal,ioBytes:{...normal.ioBytes,received:value},
    }]),/nonfinite/);
    assert.throws(()=>summarizeS5ScenarioResults([{
      ...normal,cpuMs:{...normal.cpuMs,user:value},
    }]),/nonfinite/);
  }
});
