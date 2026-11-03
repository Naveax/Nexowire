import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {renderS5CostReport} from '../../../scripts/report-s5-cost-matrix.js';
import {
  quoteS5Cost,formatS5CostCsv,S5_ASSUMPTION_DEFAULTS,S5_COST_METERS,
  type S5CostInput,type S5RateQuotes,
} from '../../../src/ops/scale-s5-cost-envelope.js';

const assumptions=():S5CostInput=>({
  ...S5_ASSUMPTION_DEFAULTS,activeUsers:2,callsPerUserDaily:1,
  workerRequestsPerCall:1,controlRequestsPerUserDaily:0,
  d1ReadsPerCall:2,d1WritesPerCall:1,reconnectionsPerUserDaily:0,
  connectionsPerUser:0,retryBasisPoints:0,days:30,
  workerCpuMsPerRequest:2,relayBytesPerCall:0,relayFractionBasisPoints:0,
});
const rates=():S5RateQuotes=>({
  workerRequests:{amount:0.1,per:1,unit:'request',currency:'USD',source:'synthetic fixture'},
  workerCpuMs:{amount:0.05,per:1,unit:'cpu-ms',currency:'USD',source:'synthetic fixture'},
  d1RowsRead:{amount:0.02,per:1,unit:'row',currency:'USD',source:'synthetic fixture'},
  d1RowsWritten:{amount:0.03,per:1,unit:'row',currency:'USD',source:'synthetic fixture'},
  monthlyBase:{amount:5,per:1,unit:'month',currency:'USD',source:'synthetic fixture'},
});

test('T-061: empty or partial assumptions are UNKNOWN, never zero usage',()=>{
  for(const a of [undefined,null,{}, {activeUsers:0}]){
    const report=quoteS5Cost(a,rates());
    assert.equal(report.monthlyUsage,'UNKNOWN');
    assert.equal(report.modeledTotal,'UNKNOWN');
    assert.equal(report.knownSubtotal,'UNKNOWN');
    assert.equal(report.actualProviderBill,'UNKNOWN');
    assert.ok(report.missing.some(field=>field.startsWith('assumptions.')));
  }
});
test('T-061: missing rates remain UNKNOWN even if monthly usage is calculable',()=>{
  const report=quoteS5Cost(assumptions(),{...rates(),d1RowsWritten:null});
  assert.notEqual(report.monthlyUsage,'UNKNOWN');
  assert.equal(report.componentCosts.d1RowsWritten,'UNKNOWN');
  assert.equal(report.modeledTotal,'UNKNOWN');
  assert.equal(report.modeledCostPerUser,'UNKNOWN');
  assert.equal(report.knownSubtotal,19.4);
  assert.ok(report.missing.includes('rates.d1RowsWritten'));
  const allUnknown=quoteS5Cost(assumptions());
  assert.equal(allUnknown.knownSubtotal,'UNKNOWN');
  assert.deepEqual(allUnknown.missing,S5_COST_METERS.map(m=>'rates.'+m));
  assert.equal(quoteS5Cost(assumptions(),null).modeledTotal,'UNKNOWN');
});
test('T-062: nonfinite and negative assumptions fail closed even when others are absent',()=>{
  for(const value of [-1,NaN,Infinity,-Infinity]){
    assert.throws(()=>quoteS5Cost({...assumptions(),activeUsers:value},rates()));
    assert.throws(()=>quoteS5Cost({activeUsers:value},rates()));
    assert.throws(()=>quoteS5Cost({...assumptions(),workerCpuMsPerRequest:value},rates()));
  }
});
test('T-062: invalid pricing, rates and arithmetic overflow do not serialize null',()=>{
  for(const value of [NaN,Infinity,-1]){
    const p=rates();p.workerRequests={...p.workerRequests!,amount:value};
    assert.throws(()=>quoteS5Cost(assumptions(),p));
  }
  const zeroDenom=rates();zeroDenom.workerCpuMs={...zeroDenom.workerCpuMs!,per:0};
  assert.throws(()=>quoteS5Cost(assumptions(),zeroDenom));
  const overflowing=rates();overflowing.workerRequests={...overflowing.workerRequests!,amount:1e308};
  assert.throws(()=>quoteS5Cost(assumptions(),overflowing));
});
test('T-063: mixed currencies, mismatched and unknown units are rejected',()=>{
  const mixed=rates();mixed.workerCpuMs={...mixed.workerCpuMs!,currency:'TRY'};
  assert.throws(()=>quoteS5Cost(assumptions(),mixed),/Mixed/);
  const badUnit=rates();badUnit.d1RowsRead={...badUnit.d1RowsRead!,unit:'request'};
  assert.throws(()=>quoteS5Cost(assumptions(),badUnit),/Invalid/);
  const unknownMeter={...rates(),relayGB:{amount:1,per:1,unit:'row',currency:'USD',source:'synthetic'}};
  assert.throws(()=>quoteS5Cost(assumptions(),unknownMeter),/Unknown cost meter/);
  const noProvenance=rates();noProvenance.workerRequests={...noProvenance.workerRequests!,source:'UNKNOWN'};
  assert.throws(()=>quoteS5Cost(assumptions(),noProvenance));
});
test('T-064: CSV headings are stable, RFC-style quoted, and formula-safe',()=>{
  const report=quoteS5Cost(assumptions(),rates());
  const csv=formatS5CostCsv([{label:'=HYPERLINK("a,b")\r\nreport',activeUsers:2,report}]);
  const [header]=csv.split('\n');
  assert.equal(header?.split(',').length,18);
  assert.ok(csv.includes('"\'=HYPERLINK(""a,b"")\r\nreport"'));
  assert.ok(csv.includes('"OFFLINE_SIMULATION_NOT_PROVIDER_BILL"'));
  assert.equal(formatS5CostCsv([{label:'safe',activeUsers:2,report}]),
    formatS5CostCsv([{label:'safe',activeUsers:2,report}]));
});
test('T-065: total and per-user formula, including zero users and explicit zero rates',()=>{
  const report=quoteS5Cost(assumptions(),rates());
  assert.deepEqual(report.monthlyUsage,{
    workerRequests:'60',d1RowsRead:'120',d1RowsWritten:'60',workerCpuMs:'120',
  });
  assert.equal(report.modeledTotal,21.2);
  assert.equal(report.modeledCostPerUser,10.6);
  assert.equal(report.actualProviderBill,'UNKNOWN');
  const noUsers=quoteS5Cost({...assumptions(),activeUsers:0},rates());
  assert.equal(noUsers.modeledTotal,5);
  assert.equal(noUsers.modeledCostPerUser,'UNKNOWN');
  const free=rates();for(const meter of S5_COST_METERS)free[meter]={...free[meter]!,amount:0};
  assert.equal(quoteS5Cost(assumptions(),free).modeledTotal,0);
});
test('T-066: report renderer does not call missing inputs a provider bill or render invalid input',()=>{
  const defaults=JSON.parse(renderS5CostReport([]));
  assert.equal(defaults.scenarios.length,5);
  assert.ok(defaults.scenarios[0].paidPartialUsd);
  assert.equal(defaults.scenarios[0].report.actualProviderBill,'UNKNOWN');
  assert.equal(defaults.pricesAsOf,'2026-10-18');
  const dir=mkdtempSync(join(tmpdir(),'nexowire-k11-'));
  try{
    const empty=join(dir,'empty.json');writeFileSync(empty,'{}');
    const output=JSON.parse(renderS5CostReport(['--input',empty]));
    assert.equal(output.actualProviderBill,'UNKNOWN');
    assert.match(output.source,/SIMULATION/);
    assert.equal(output.scenarios[0].report.modeledTotal,'UNKNOWN');
    const csv=renderS5CostReport(['--csv','--input',empty]);
    assert.ok(csv.includes('"UNKNOWN"'));
    const invalid=join(dir,'invalid.json');
    writeFileSync(invalid,JSON.stringify({assumptions:{...assumptions(),activeUsers:-1},rates:rates()}));
    assert.throws(()=>renderS5CostReport(['--input',invalid]),/Unsafe/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
