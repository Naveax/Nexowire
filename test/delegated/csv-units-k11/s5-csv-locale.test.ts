import test from 'node:test';
import assert from 'node:assert/strict';
import {
  quoteS5Cost,formatS5CostCsv,S5_ASSUMPTION_DEFAULTS,
  type S5RateQuotes,
} from '../../../src/ops/scale-s5-cost-envelope.js';

const assumptions={...S5_ASSUMPTION_DEFAULTS,
  activeUsers:1,callsPerUserDaily:1,workerRequestsPerCall:1,
  controlRequestsPerUserDaily:0,reconnectionsPerUserDaily:0,
  connectionsPerUser:0,retryBasisPoints:0,days:1,
  workerCpuMsPerRequest:1,d1ReadsPerCall:1,d1WritesPerCall:1,
  relayBytesPerCall:0,relayFractionBasisPoints:0,
};
const prices=():S5RateQuotes=>({
  workerRequests:{amount:1234.5,per:1,unit:'request',currency:'TRY',source:'synthetic locale fixture'},
  workerCpuMs:{amount:0,per:1,unit:'cpu-ms',currency:'TRY',source:'synthetic locale fixture'},
  d1RowsRead:{amount:0,per:1,unit:'row',currency:'TRY',source:'synthetic locale fixture'},
  d1RowsWritten:{amount:0,per:1,unit:'row',currency:'TRY',source:'synthetic locale fixture'},
  monthlyBase:{amount:0,per:1,unit:'month',currency:'TRY',source:'synthetic locale fixture'},
});

test('T-131: Turkish locale formatting does not corrupt machine-readable CSV decimals',()=>{
  assert.equal(new Intl.NumberFormat('tr-TR',{minimumFractionDigits:2}).format(1234.5),'1.234,50');
  const report=quoteS5Cost(assumptions,prices());
  const csv=formatS5CostCsv([{label:'TR locale hypothetical',activeUsers:1,report}]);
  assert.equal(report.currency,'TRY');
  assert.equal(report.modeledTotal,1234.5);
  assert.ok(csv.includes('"1234.5"'));
  assert.ok(!csv.includes('"1.234,50"'));
  assert.ok(csv.includes('"TRY"'));
  assert.ok(csv.includes('"monthlyWorkerCpuMs"'));
  assert.ok(csv.includes('"cost_monthlyBase"'));
});

test('T-131: price-unit and currency inconsistency cannot slip into a CSV report',()=>{
  const wrongUnit=prices();
  wrongUnit.workerCpuMs={...wrongUnit.workerCpuMs!,unit:'request'};
  assert.throws(()=>quoteS5Cost(assumptions,wrongUnit),/Invalid cost rate/);
  const mixed=prices();
  mixed.workerRequests={...mixed.workerRequests!,currency:'USD'};
  assert.throws(()=>quoteS5Cost(assumptions,mixed),/Mixed cost currencies/);
  const unknown=quoteS5Cost(assumptions,{...prices(),workerRequests:null});
  const csv=formatS5CostCsv([{label:'missing price',activeUsers:1,report:unknown}]);
  assert.equal(unknown.modeledTotal,'UNKNOWN');
  assert.ok(csv.includes('"UNKNOWN"'));
  assert.ok(csv.includes('"rates.workerRequests"'));
});

test('T-131: CSV labels and two-row order are stable even with commas and spreadsheet prefixes',()=>{
  const report=quoteS5Cost(assumptions,prices());
  const csv=formatS5CostCsv([
    {label:'Istanbul, TRY',activeUsers:1,report},
    {label:'  =SUM(1,2)',activeUsers:1,report},
  ]);
  const [header,first,second]=csv.trimEnd().split('\n');
  assert.ok(header?.startsWith('"label","classification","currency"'));
  assert.ok(first?.startsWith('"Istanbul, TRY"'));
  assert.ok(second?.startsWith('"\'  =SUM(1,2)"'));
  assert.equal(csv.match(/"OFFLINE_SIMULATION_NOT_PROVIDER_BILL"/g)?.length,2);
});
