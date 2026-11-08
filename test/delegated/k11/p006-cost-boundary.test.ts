import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {renderS5CostReport} from '../../../scripts/report-s5-cost-matrix.js';
import {
  quoteS5Cost,formatS5CostCsv,S5_ASSUMPTION_DEFAULTS,S5_COST_METERS,
  type S5RateQuotes,
} from '../../../src/ops/scale-s5-cost-envelope.js';
import {parseScaleTransportMetricRows} from '../../../src/ops/scale-transport-metrics.js';

const one=()=>({...S5_ASSUMPTION_DEFAULTS,activeUsers:1,callsPerUserDaily:1,
  workerRequestsPerCall:1,controlRequestsPerUserDaily:0,d1ReadsPerCall:0,
  d1WritesPerCall:0,reconnectionsPerUserDaily:0,connectionsPerUser:0,
  retryBasisPoints:0,days:1,workerCpuMsPerRequest:0,relayBytesPerCall:0,
  relayFractionBasisPoints:0});
const pricing=(amount:number):S5RateQuotes=>Object.fromEntries(
  S5_COST_METERS.map(meter=>[meter,{
    amount:meter==='workerRequests'?amount:0,per:1,
    unit:meter==='workerRequests'?'request':meter==='workerCpuMs'?'cpu-ms':
      meter==='monthlyBase'?'month':'row',currency:'USD',
    source:'deliberately synthetic local rate',
  }]),
) as S5RateQuotes;

test('T-596 #487: 0, sub-cent, cent boundary and safe high USD quote retain meaning',()=>{
  for(const [raw,expected] of [
    [0,0],[0.000000001,0.000000001],[0.004,0.004],[0.0049,0.0049],
    [0.005,0.01],[0.009,0.01],[1e12,1e12],
  ]){
    const report=quoteS5Cost(one(),pricing(raw!));
    assert.equal(report.componentCosts.workerRequests,expected,`component ${raw}`);
    assert.equal(report.modeledTotal,expected,`total ${raw}`);
    assert.equal(report.modeledCostPerUser,expected,`per-user ${raw}`);
    assert.equal(report.actualProviderBill,'UNKNOWN');
  }
  assert.throws(()=>quoteS5Cost(one(),pricing(1e14)),/Unsafe projected cost precision/);
});

test('T-597 #539: S5 JSON and CSV are offline models with unknown invoice and hosted completion',()=>{
  const report=quoteS5Cost(one(),pricing(0.004));
  assert.equal(report.classification,'OFFLINE_SIMULATION_NOT_PROVIDER_BILL');
  assert.equal(report.actualProviderBill,'UNKNOWN');
  assert.equal(report.capacityEvidence.measuredCompletedToolCallsPerDay,'UNKNOWN');
  assert.equal(report.capacityEvidence.measuredSustainedHostedWssSessions,'UNKNOWN');
  const csv=formatS5CostCsv([{label:'unverified only',activeUsers:1,report}]);
  assert.match(csv,/"OFFLINE_SIMULATION_NOT_PROVIDER_BILL"/);
  assert.match(csv,/"UNKNOWN",""\n$/);
  assert.doesNotMatch(csv,/"PROVIDER_BILL"|"HOSTED_ACCEPTED"/);
  const builtIn=JSON.parse(renderS5CostReport([]));
  assert.equal(builtIn.actualProviderBill,'UNKNOWN');
  for(const scenario of builtIn.scenarios){
    assert.equal(scenario.report.actualProviderBill,'UNKNOWN');
    assert.equal(scenario.report.capacityEvidence.measuredSustainedHostedWssSessions,'UNKNOWN');
  }
});

test('T-599 #487: K12 reconnect and K18 transfer local evidence cannot be reclassified as provider bills',()=>{
  const reconnect=JSON.parse(readFileSync(fileURLToPath(new URL(
    '../../../docs/reports/s5-reconnect-loopback-20261018.json',import.meta.url)),'utf8'));
  const transfer=JSON.parse(readFileSync(fileURLToPath(new URL(
    '../../../docs/reports/s5-stream-loopback-20261020.json',import.meta.url)),'utf8'));
  assert.equal(reconnect.cloud.observed,false);
  assert.equal(reconnect.cloud.costUsd,null);
  assert.equal(reconnect.soak.actual24hRun,false);
  assert.match(reconnect.classification,/LOCAL_WS_ONLY_NOT_STAGING_PROVIDER/);
  assert.equal(transfer.stream.providerCountersMeasured,false);
  assert.equal(transfer.stream.nativeToolCompletions,0);
  assert.equal(transfer.actualAuthenticatedWss100Plus,false);
  const parsed=parseScaleTransportMetricRows([{
    name:'agent.reconnects',events:360,bytes:0,eventsUnit:'count',bytesUnit:'bytes',
  }]);
  assert.equal(parsed['agent.reconnects'].classification,'OBSERVED');
  assert.equal(parsed['agent.reconnects'].events,360);
  assert.equal(parsed['agent.ack_responses'].classification,'UNKNOWN');
  assert.equal(quoteS5Cost(one(),pricing(0)).actualProviderBill,'UNKNOWN');
});

test('T-599 #487: offline report CLI rejects transport evidence masquerading as a price input',()=>{
  const proof={label:'not a bill',assumptions:one(),rates:pricing(0),
    reconnectEvidence:{kind:'SYNTHETIC_LOOPBACK_WS_NO_REAL_NATIVE_TOOL',costUsd:0}};
  // A report reader must not silently discard unrelated measurement metadata
  // and then present a synthetic zero quote as an external provider invoice.
  const folder=mkdtempSync(join(tmpdir(),'k11-s5-evidence-'));
  try{
    const source=join(folder,'wrong-shape.json');
    writeFileSync(source,JSON.stringify(proof));
    assert.throws(()=>renderS5CostReport(['--input',source]),/Unexpected offline scenario field/);
    assert.throws(()=>renderS5CostReport(['--csv','--input',source]),/Unexpected offline scenario field/);
  }finally{rmSync(folder,{recursive:true,force:true});}
});
