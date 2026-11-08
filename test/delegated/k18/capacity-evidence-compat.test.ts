import test from 'node:test';
import assert from 'node:assert/strict';
import {
  quoteS5Cost,
  S5_ASSUMPTION_DEFAULTS,
  type S5QuotedCostReport,
} from '../../../src/ops/scale-s5-cost-envelope.js';
import {
  parseScaleTransportMetricRows,
  safelyParseScaleTransportMetricRows,
  type ScaleMetricObservation,
} from '../../../src/ops/scale-transport-metrics.js';
import {summarizeS5ScenarioResults} from '../../../scripts/report-s5-measured-scenarios.js';
import type {S5LoadResult} from '../../../scripts/bench-s5-loopback-ws-capacity.js';

// Cross-module regression for #1102 on upstream main and #1107/#1119 Draft.
// These values come from offline loopback fixtures, never a hosted provider.
function sample(peak=128, p99=12):S5LoadResult {
  return {
    kind:'SYNTHETIC_LOOPBACK_WS_OWNER_SQLITE',
    clients:peak,mode:'isolated',callsPerClient:1,
    sockets:{connected:peak,peak,closed:peak},
    rpc:{attempted:peak,reserved:peak,duplicate:0,rateLimited:0,
      backpressure:0,other:0,peakInFlight:1,peakQueue:1,perSecond:1},
    latencyMs:{p50:1,p95:p99,p99,max:p99},
    cpuMs:{user:1,system:1},
    memoryBytes:{rssStart:1024,rssPeak:2048,rssEnd:2048},
    ioBytes:{sqlite:4096,wal:0,received:1024,sent:1024},
    fairness:{jainIndex:1,minUserSuccess:1,maxUserSuccess:1},
    ledger:{rows:peak,dailyUsed:peak,toolExecutions:0},
    elapsedMs:1500,constraints:['offline synthetic only'],
  };
}

test('T-497 #487 #1102 capacityEvidence type remains UNKNOWN next to measured local sockets',()=>{
  const quote:S5QuotedCostReport=quoteS5Cost(S5_ASSUMPTION_DEFAULTS);
  const local=summarizeS5ScenarioResults([sample()]);
  assert.equal(local.measurementClassification,'LOCAL_SYNTHETIC_ONLY');
  assert.equal(local.scenarios[0]?.peakSockets,128);
  assert.equal(local.capacityEstimate,null);
  assert.equal(local.providerCapacityProven,false);
  assert.deepEqual({
    calls:quote.capacityEvidence.measuredCompletedToolCallsPerDay,
    hostedSessions:quote.capacityEvidence.measuredSustainedHostedWssSessions,
  },{calls:'UNKNOWN',hostedSessions:'UNKNOWN'});
  assert.match(quote.capacityEvidence.reason,/hosted WSS/);
  assert.equal(quote.classification,'OFFLINE_SIMULATION_NOT_PROVIDER_BILL');
  assert.equal(quote.actualProviderBill,'UNKNOWN');
  // A projected request count may be numeric without becoming observed throughput.
  assert.notEqual(quote.monthlyUsage,'UNKNOWN');
});

test('T-497 #487 incomplete assumptions never infer a measured source from zeroes',()=>{
  const quote:S5QuotedCostReport=quoteS5Cost({});
  const local=summarizeS5ScenarioResults([]);
  assert.equal(quote.monthlyUsage,'UNKNOWN');
  assert.equal(quote.capacityEvidence.measuredCompletedToolCallsPerDay,'UNKNOWN');
  assert.equal(quote.capacityEvidence.measuredSustainedHostedWssSessions,'UNKNOWN');
  assert.equal(local.measurementClassification,'UNKNOWN');
  assert.equal(local.capacityEstimate,null);
  assert.deepEqual(local.scenarios,[]);
});

test('T-499 #487 only raw bytes/count observations survive decimal/binary unit confusion',()=>{
  const row={name:'agent.rx_frames',events:1,bytes:225280,
    eventsUnit:'count',bytesUnit:'bytes'};
  const good:ScaleMetricObservation=parseScaleTransportMetricRows([row])['agent.rx_frames'];
  assert.deepEqual(good,{classification:'OBSERVED',events:1,bytes:225280});
  for(const bytesUnit of ['KB','KiB','MB','MiB','seconds']){
    const corrupted={...row,bytesUnit};
    assert.throws(()=>parseScaleTransportMetricRows([corrupted]),/units/);
    assert.deepEqual(safelyParseScaleTransportMetricRows([corrupted])['agent.rx_frames'],
      {classification:'UNKNOWN',events:null,bytes:null});
  }
  for(const eventsUnit of ['milliseconds','seconds','bytes']){
    const corrupted={...row,eventsUnit};
    assert.deepEqual(safelyParseScaleTransportMetricRows([corrupted])['agent.rx_frames'],
      {classification:'UNKNOWN',events:null,bytes:null});
  }
});

test('T-499 #487 elapsed/percentile milliseconds reject duration strings and NaN, not zero-fill',()=>{
  const base=sample();
  for(const elapsedMs of ['1.5s','1500ms',Number.NaN,Infinity,-1]){
    assert.throws(()=>summarizeS5ScenarioResults([
      {...base,elapsedMs} as S5LoadResult,
    ]),/Invalid|nonfinite/);
  }
  for(const p99 of ['12s','12ms',Number.NaN,Infinity]){
    assert.throws(()=>summarizeS5ScenarioResults([
      {...base,latencyMs:{...base.latencyMs,p99}} as S5LoadResult,
    ]),/Invalid|nonfinite/);
  }
  assert.equal(summarizeS5ScenarioResults([base]).scenarios[0]?.wallMs,1500);
});

test('T-500 #539 local p95/p99 and 256 sockets cannot forge a provider confidence interval',()=>{
  const local=summarizeS5ScenarioResults([sample(256,9999)]);
  const quote=quoteS5Cost(S5_ASSUMPTION_DEFAULTS);
  assert.equal(local.scenarios[0]?.p99Ms,9999);
  assert.equal(local.scenarios[0]?.peakSockets,256);
  assert.equal(local.capacityEstimate,null);
  assert.equal(local.providerCapacityProven,false);
  // Before #1107 merges the field does not exist on main. If it does exist,
  // it must remain null for synthetic-only and empty inputs.
  assert.equal((local as Record<string,unknown>).capacityConfidenceInterval??null,null);
  assert.equal(quote.capacityEvidence.measuredSustainedHostedWssSessions,'UNKNOWN');
  assert.equal(quote.capacityEvidence.measuredCompletedToolCallsPerDay,'UNKNOWN');
  assert.equal(quote.actualProviderBill,'UNKNOWN');
});
