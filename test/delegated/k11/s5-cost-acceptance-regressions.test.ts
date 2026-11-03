import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  quoteS5Cost,estimateS5Cost,projectS5Matrix,S5_ASSUMPTION_DEFAULTS,
  formatS5CostCsv,type S5CostInput,type S5RateQuotes,
} from '../../../src/ops/scale-s5-cost-envelope.js';
import {renderS5CostReport} from '../../../scripts/report-s5-cost-matrix.js';

const workload=():S5CostInput=>({
  ...S5_ASSUMPTION_DEFAULTS,activeUsers:1,callsPerUserDaily:1,
  workerRequestsPerCall:1,controlRequestsPerUserDaily:0,
  d1ReadsPerCall:1,d1WritesPerCall:1,
  reconnectionsPerUserDaily:0,connectionsPerUser:0,
  retryBasisPoints:0,days:1,workerCpuMsPerRequest:1,
  relayBytesPerCall:0,relayFractionBasisPoints:0,
});
const prices=(currency='USD'):S5RateQuotes=>({
  workerRequests:{amount:1,per:1,unit:'request',currency,source:'fictional fixture'},
  workerCpuMs:{amount:1,per:1,unit:'cpu-ms',currency,source:'fictional fixture'},
  d1RowsRead:{amount:1,per:1,unit:'row',currency,source:'fictional fixture'},
  d1RowsWritten:{amount:1,per:1,unit:'row',currency,source:'fictional fixture'},
  monthlyBase:{amount:1,per:1,unit:'month',currency,source:'fictional fixture'},
});

test('T-189: explicit free rate is calculable zero while absent price stays UNKNOWN',()=>{
  const allZero=prices();
  for(const rate of Object.values(allZero))rate!.amount=0;
  const zero=quoteS5Cost(workload(),allZero);
  assert.equal(zero.modeledTotal,0);
  assert.equal(zero.knownSubtotal,0);
  assert.equal(zero.modeledCostPerUser,0);
  assert.deepEqual(zero.missing,[]);
  const absent=prices();absent.workerCpuMs=null;
  const unknown=quoteS5Cost(workload(),absent);
  assert.equal(unknown.componentCosts.workerCpuMs,'UNKNOWN');
  assert.equal(unknown.modeledTotal,'UNKNOWN');
  assert.equal(unknown.modeledCostPerUser,'UNKNOWN');
  assert.ok(unknown.missing.includes('rates.workerCpuMs'));
  assert.equal(quoteS5Cost(workload(),{}).knownSubtotal,'UNKNOWN');
});

test('T-190: TL is not an ISO quote; a USD+TRY mix cannot produce a subtotal',()=>{
  const turkish=prices('TRY');
  assert.equal(quoteS5Cost(workload(),turkish).currency,'TRY');
  const mislabeled=prices('TL');
  assert.throws(()=>quoteS5Cost(workload(),mislabeled),/Invalid cost rate/);
  const mixed=prices('USD');mixed.d1RowsWritten={...mixed.d1RowsWritten!,currency:'TRY'};
  assert.throws(()=>quoteS5Cost(workload(),mixed),/Mixed cost currencies/);
});

test('T-191: decimal kB versus binary KiB/MiB and monthly window scaling are distinct',()=>{
  const base={...workload(),callsPerUserDaily:1024*1024,relayFractionBasisPoints:10000};
  const decimal=estimateS5Cost({...base,relayBytesPerCall:1000});
  const binary=estimateS5Cost({...base,relayBytesPerCall:1024});
  assert.equal(decimal.daily.relayGiBApprox,0.9766);
  assert.equal(binary.daily.relayGiBApprox,1);
  assert.equal(estimateS5Cost({...workload(),relayBytesPerCall:1024*1024,
    callsPerUserDaily:1024,relayFractionBasisPoints:10000}).daily.relayGiBApprox,1);
  const day=estimateS5Cost({...workload(),days:1});
  const month=estimateS5Cost({...workload(),days:30});
  assert.equal(day.daily.workerRequests,month.daily.workerRequests);
  assert.equal(Number(month.monthly.workerRequests),Number(day.monthly.workerRequests)*30);
  assert.throws(()=>estimateS5Cost({...workload(),relayBytesPerCall:Infinity}));
  assert.throws(()=>estimateS5Cost({...workload(),days:-1}));
});

test('T-192: free-envelope safeguard is independent of actual bill UNKNOWN',()=>{
  const within=estimateS5Cost(workload());
  const above=estimateS5Cost({...workload(),activeUsers:10000,callsPerUserDaily:205});
  assert.equal(within.freeEnvelope.numericThresholdsFit,true);
  assert.equal(above.freeEnvelope.numericThresholdsFit,false);
  assert.equal(within.freeEnvelope.zeroExtraInvoiceProven,false);
  assert.equal(above.freeEnvelope.zeroExtraInvoiceProven,false);
  assert.equal(quoteS5Cost(workload()).actualProviderBill,'UNKNOWN');
  assert.equal(quoteS5Cost({...workload(),activeUsers:10000,callsPerUserDaily:205}).actualProviderBill,'UNKNOWN');
  assert.deepEqual(quoteS5Cost(workload()).freeThresholdSafeguard,
    {numericThresholdsFit:true,zeroExtraInvoiceProven:false});
  assert.deepEqual(quoteS5Cost({...workload(),activeUsers:10000,callsPerUserDaily:205}).freeThresholdSafeguard,
    {numericThresholdsFit:false,zeroExtraInvoiceProven:false});
  assert.equal(quoteS5Cost(null).freeThresholdSafeguard.numericThresholdsFit,'UNKNOWN');
});

test('T-193: invalid CSV inputs never emit a partial header and valid header is deterministic',()=>{
  const dir=mkdtempSync(join(tmpdir(),'s5-k11-csv-negative-'));
  try{
    const filepath=join(dir,'scenario.json');
    writeFileSync(filepath,JSON.stringify({assumptions:workload(),rates:prices()}));
    const flags=['--csv','--input',filepath];
    const valid=renderS5CostReport(flags);
    const header=valid.split('\n')[0];
    assert.ok(header?.includes('"actualProviderBill"'));
    writeFileSync(filepath,JSON.stringify({assumptions:{...workload(),activeUsers:-1},rates:prices()}));
    assert.throws(()=>renderS5CostReport(flags),/Unsafe/);
    writeFileSync(filepath,JSON.stringify({assumptions:{...workload(),activeUsers:null},rates:prices()}));
    const missing=renderS5CostReport(flags);
    assert.equal(missing.split('\n')[0],header);
    assert.ok(missing.includes('"UNKNOWN"'));
    writeFileSync(filepath,'{"assumptions":{"activeUsers":Infinity}}');
    assert.throws(()=>renderS5CostReport(flags),/JSON|Unexpected/);
    assert.throws(()=>quoteS5Cost({...workload(),activeUsers:Infinity}),/Unsafe/);
    writeFileSync(filepath,JSON.stringify({assumptions:workload(),rates:prices()}));
    assert.equal(renderS5CostReport(flags).split('\n')[0],header);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('T-194: all cost confidence claims reference source-only acceptance evidence',()=>{
  const sourcePath='docs/SCALE_V2_S5_LOAD_COST_ACCEPTANCE_20261018.md';
  const document=readFileSync(sourcePath,'utf8');
  assert.match(document,/No Cloudflare usage API was called/);
  assert.match(document,/zero incremental operator bill is NOT proven/);
  const matrix=projectS5Matrix();
  for(const scenario of matrix){
    assert.equal(scenario.classification,'OFFLINE_PROJECTION_NOT_PROVIDER_METER');
    assert.equal(scenario.freeEnvelope.zeroExtraInvoiceProven,false);
    assert.ok(scenario.paidPartialUsd.excludedFactors.length>0);
  }
  const report=JSON.parse(renderS5CostReport([]));
  assert.match(report.source,/OFFLINE SIMULATION/);
  assert.equal(report.actualProviderBill,'UNKNOWN');
  assert.equal(report.limitationsEvidence.sourcePath,sourcePath);
  assert.equal(report.limitationsEvidence.providerInvoiceStatus,'UNKNOWN');
  assert.equal(report.scenarios.length,matrix.length);
  for(const scenario of report.scenarios){
    assert.equal(scenario.report.actualProviderBill,'UNKNOWN');
    assert.match(scenario.embeddedRateWarning,/not a current provider quote/);
  }
  assert.match(formatS5CostCsv([{label:'only offline',activeUsers:1,
    report:quoteS5Cost(workload(),prices())}]),/OFFLINE_SIMULATION_NOT_PROVIDER_BILL/);
});
