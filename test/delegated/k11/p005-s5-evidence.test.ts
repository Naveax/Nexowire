import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {renderS5CostReport} from '../../../scripts/report-s5-cost-matrix.js';
import {
  quoteS5Cost,formatS5CostCsv,S5_ASSUMPTION_DEFAULTS,S5_COST_METERS,
  type S5RateQuotes,
} from '../../../src/ops/scale-s5-cost-envelope.js';

const input=()=>({...S5_ASSUMPTION_DEFAULTS,activeUsers:1,callsPerUserDaily:1,
  workerRequestsPerCall:1,controlRequestsPerUserDaily:0,
  d1ReadsPerCall:0,d1WritesPerCall:0,reconnectionsPerUserDaily:0,
  connectionsPerUser:0,retryBasisPoints:0,days:1,workerCpuMsPerRequest:0,
  relayBytesPerCall:0,relayFractionBasisPoints:0});
const quotes=():S5RateQuotes=>Object.fromEntries(S5_COST_METERS.map(meter=>[
  meter,{amount:0,per:1,unit:meter==='workerRequests'?'request':
    meter==='workerCpuMs'?'cpu-ms':meter==='monthlyBase'?'month':'row',
  currency:'USD',source:'synthetic fixture (not provider billing)'},
])) as S5RateQuotes;

test('T-455/T-456 #487/#539: merged capacity evidence stays UNKNOWN without breaking 18-column CSV',()=>{
  const report=quoteS5Cost(input(),quotes());
  assert.deepEqual({
    completed:report.capacityEvidence.measuredCompletedToolCallsPerDay,
    sessions:report.capacityEvidence.measuredSustainedHostedWssSessions,
    invoice:report.actualProviderBill,
  },{completed:'UNKNOWN',sessions:'UNKNOWN',invoice:'UNKNOWN'});
  assert.match(report.capacityEvidence.reason,/hosted|authenticated|observations/i);
  const csv=formatS5CostCsv([{label:'local-only',activeUsers:1,report}]);
  const lines=csv.trimEnd().split('\n');
  assert.equal(lines.length,2);
  assert.equal(lines[0]?.split(',').length,18);
  assert.ok(lines[0]?.startsWith('"label","classification","currency","activeUsers"'));
  assert.ok(lines[1]?.endsWith('"UNKNOWN",""'));
  assert.doesNotMatch(csv,/measuredCompletedToolCallsPerDay|measuredSustainedHostedWssSessions/);
});

test('T-457 #487: missing a real quote never serializes a customer invoice of zero in JSON or CSV',()=>{
  const partial=quotes();
  delete partial.d1RowsRead;
  const report=quoteS5Cost(input(),partial);
  assert.equal(report.knownSubtotal,0);
  assert.equal(report.modeledTotal,'UNKNOWN');
  assert.equal(report.actualProviderBill,'UNKNOWN');
  assert.ok(report.missing.includes('rates.d1RowsRead'));
  const folder=mkdtempSync(join(tmpdir(),'k11-s5-p005-'));
  try{
    const fixture=join(folder,'missing-rate.json');
    writeFileSync(fixture,JSON.stringify({label:'offline price quote',assumptions:input(),rates:partial}));
    const output=JSON.parse(renderS5CostReport(['--input',fixture]));
    assert.equal(output.scenarios[0].report.modeledTotal,'UNKNOWN');
    assert.equal(output.scenarios[0].report.actualProviderBill,'UNKNOWN');
    assert.equal(output.actualProviderBill,'UNKNOWN');
    const csv=renderS5CostReport(['--csv','--input',fixture]);
    assert.match(csv,/"UNKNOWN","UNKNOWN","rates\.d1RowsRead"/);
  }finally{rmSync(folder,{recursive:true,force:true});}
});

test('T-458 #539/R12: even projected high traffic never upgrades unmeasured hosted capacity',()=>{
  for(const activeUsers of [0,1,10_000]){
    const report=quoteS5Cost({...input(),activeUsers,callsPerUserDaily:1000},quotes());
    assert.equal(report.capacityEvidence.measuredCompletedToolCallsPerDay,'UNKNOWN');
    assert.equal(report.capacityEvidence.measuredSustainedHostedWssSessions,'UNKNOWN');
    assert.equal(report.actualProviderBill,'UNKNOWN');
    assert.ok(!/\b(?:[1-9]\d*)\b/.test(JSON.stringify(report.capacityEvidence)));
  }
});

test('T-459 #487: nonzero sub-cent provider quote must not become a modeled zero dollar cost',()=>{
  const small=quotes();
  small.workerRequests={amount:0.001,per:1_000_000,unit:'request',
    currency:'USD',source:'synthetic sub-cent fixture'};
  const report=quoteS5Cost(input(),small);
  assert.equal(report.monthlyUsage==='UNKNOWN'?null:report.monthlyUsage.workerRequests,'1');
  assert.ok(typeof report.componentCosts.workerRequests==='number' &&
    report.componentCosts.workerRequests>0,'positive worker request charge cannot be rounded to 0');
  assert.ok(typeof report.modeledTotal==='number'&&report.modeledTotal>0);
  assert.ok(typeof report.modeledCostPerUser==='number'&&report.modeledCostPerUser>0);
  assert.equal(report.actualProviderBill,'UNKNOWN');
});

test('T-459 #487: mixed money, unsafe fractional counts and nonfinite rates fail closed',()=>{
  const usd=quotes();
  usd.d1RowsRead={...usd.d1RowsRead!,currency:'TRY'};
  assert.throws(()=>quoteS5Cost(input(),usd),/Mixed cost currencies/);
  assert.throws(()=>quoteS5Cost({...input(),activeUsers:0.5},quotes()),/Unsafe/);
  const nan=quotes();nan.workerRequests={...nan.workerRequests!,amount:NaN};
  assert.throws(()=>quoteS5Cost(input(),nan),/Invalid cost rate/);
  const inf=quotes();inf.workerRequests={...inf.workerRequests!,per:Infinity};
  assert.throws(()=>quoteS5Cost(input(),inf),/Invalid cost rate/);
  const finiteButUnroundable=quotes();
  finiteButUnroundable.workerRequests={...finiteButUnroundable.workerRequests!,amount:1e308};
  assert.throws(()=>quoteS5Cost(input(),finiteButUnroundable),/Unsafe projected cost precision/);
});
