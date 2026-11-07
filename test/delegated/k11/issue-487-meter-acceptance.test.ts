import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  S5_ASSUMPTION_DEFAULTS,estimateS5Cost,quoteS5Cost,
  type S5CostInput,type S5RateQuotes,
} from '../../../src/ops/scale-s5-cost-envelope.js';
import {renderS5CostReport} from '../../../scripts/report-s5-cost-matrix.js';

const usage=():S5CostInput=>({
  ...S5_ASSUMPTION_DEFAULTS,activeUsers:1,callsPerUserDaily:1,
  workerRequestsPerCall:1,controlRequestsPerUserDaily:0,
  d1ReadsPerCall:0,d1WritesPerCall:0,reconnectionsPerUserDaily:0,
  connectionsPerUser:0,retryBasisPoints:0,days:1,
  workerCpuMsPerRequest:1,relayBytesPerCall:0,relayFractionBasisPoints:0,
});
const quotes=():S5RateQuotes=>({
  workerRequests:{amount:0,per:1,unit:'request',currency:'USD',source:'synthetic fixture'},
  workerCpuMs:{amount:0,per:1,unit:'cpu-ms',currency:'USD',source:'synthetic fixture'},
  d1RowsRead:{amount:0,per:1,unit:'row',currency:'USD',source:'synthetic fixture'},
  d1RowsWritten:{amount:0,per:1,unit:'row',currency:'USD',source:'synthetic fixture'},
  monthlyBase:{amount:0,per:1,unit:'month',currency:'USD',source:'synthetic fixture'},
});

test('T-316/317 #487: missing price and mixed currency never become a zero-cost forecast',()=>{
  const missing=quotes();missing.workerCpuMs=null;
  assert.equal(quoteS5Cost(usage(),missing).modeledTotal,'UNKNOWN');
  assert.equal(quoteS5Cost(usage(),missing).componentCosts.workerCpuMs,'UNKNOWN');
  const free=quoteS5Cost(usage(),quotes());
  assert.equal(free.modeledTotal,0);
  assert.equal(free.actualProviderBill,'UNKNOWN');
  const mixed=quotes();mixed.monthlyBase={...mixed.monthlyBase!,currency:'TRY'};
  assert.throws(()=>quoteS5Cost(usage(),mixed),/Mixed cost currencies/);
});

test('T-318 #539/R12: projected logical usage cannot masquerade as hosted completed capacity',()=>{
  for(const users of [1,100,10000]){
    const modeled=quoteS5Cost({...usage(),activeUsers:users},quotes());
    assert.equal(modeled.capacityEvidence.measuredCompletedToolCallsPerDay,'UNKNOWN');
    assert.equal(modeled.capacityEvidence.measuredSustainedHostedWssSessions,'UNKNOWN');
    assert.match(modeled.capacityEvidence.reason,/hosted|authenticated|observed/i);
    assert.equal(modeled.actualProviderBill,'UNKNOWN');
  }
  const incomplete=quoteS5Cost(null);
  assert.equal(incomplete.capacityEvidence.measuredCompletedToolCallsPerDay,'UNKNOWN');
});

test('T-319 #487: exact daily Free threshold, over-limit and invalid usage are distinct',()=>{
  const exact=estimateS5Cost({...usage(),callsPerUserDaily:100000});
  const over=estimateS5Cost({...usage(),callsPerUserDaily:100001});
  assert.equal(exact.daily.workerRequests,'100000');
  assert.equal(exact.freeEnvelope.numericThresholdsFit,true);
  assert.equal(over.daily.workerRequests,'100001');
  assert.equal(over.freeEnvelope.numericThresholdsFit,false);
  assert.equal(exact.freeEnvelope.zeroExtraInvoiceProven,false);
  assert.equal(over.freeEnvelope.zeroExtraInvoiceProven,false);
  for(const bad of [NaN,Infinity,-1,1.25]){
    assert.throws(()=>estimateS5Cost({...usage(),callsPerUserDaily:bad}));
  }
  assert.equal(quoteS5Cost({...usage(),callsPerUserDaily:100001}).freeThresholdSafeguard.numericThresholdsFit,false);
});

test('T-320 #487: an offline sample report never certifies provider bill or physical capacity',()=>{
  const folder=mkdtempSync(join(tmpdir(),'k11-issue-487-'));
  try{
    const path=join(folder,'unknown-price.json');
    writeFileSync(path,JSON.stringify({label:'offline only',assumptions:usage(),rates:{}}));
    const report=JSON.parse(renderS5CostReport(['--input',path]));
    assert.match(report.source,/OFFLINE SIMULATION/);
    assert.equal(report.actualProviderBill,'UNKNOWN');
    assert.equal(report.scenarios[0].report.modeledTotal,'UNKNOWN');
    assert.equal(report.scenarios[0].report.capacityEvidence.measuredCompletedToolCallsPerDay,'UNKNOWN');
    assert.equal(report.scenarios[0].report.capacityEvidence.measuredSustainedHostedWssSessions,'UNKNOWN');
    assert.equal(report.limitationsEvidence.providerInvoiceStatus,'UNKNOWN');
    assert.equal(report.scenarios[0].report.freeThresholdSafeguard.zeroExtraInvoiceProven,false);
  }finally{rmSync(folder,{recursive:true,force:true});}
});
