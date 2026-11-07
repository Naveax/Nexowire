import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  quoteS5Cost,formatS5CostCsv,S5_ASSUMPTION_DEFAULTS,S5_COST_METERS,
  type S5RateQuotes,
} from '../../../src/ops/scale-s5-cost-envelope.js';
import {renderS5CostReport} from '../../../scripts/report-s5-cost-matrix.js';

const assumptions={...S5_ASSUMPTION_DEFAULTS,
  activeUsers:10000,callsPerUserDaily:205,
};
const zeroRates=():S5RateQuotes=>({
  workerRequests:{amount:0,per:1,unit:'request',currency:'USD',source:'fictional zero fixture'},
  workerCpuMs:{amount:0,per:1,unit:'cpu-ms',currency:'USD',source:'fictional zero fixture'},
  d1RowsRead:{amount:0,per:1,unit:'row',currency:'USD',source:'fictional zero fixture'},
  d1RowsWritten:{amount:0,per:1,unit:'row',currency:'USD',source:'fictional zero fixture'},
  monthlyBase:{amount:0,per:1,unit:'month',currency:'USD',source:'fictional zero fixture'},
});

test('T-379 #487: missing provider rates never make a commercial zero bill',()=>{
  const report=quoteS5Cost(assumptions,{});
  assert.equal(report.currency,'UNKNOWN');
  assert.equal(report.knownSubtotal,'UNKNOWN');
  assert.equal(report.modeledTotal,'UNKNOWN');
  assert.equal(report.actualProviderBill,'UNKNOWN');
  assert.equal(report.freeThresholdSafeguard.numericThresholdsFit,false);
  assert.equal(report.freeThresholdSafeguard.zeroExtraInvoiceProven,false);
  assert.deepEqual(report.missing,S5_COST_METERS.map(m=>'rates.'+m));
  const csv=formatS5CostCsv([{label:'unpriced large scenario',activeUsers:10000,report}]);
  assert.ok(csv.includes('"UNKNOWN"'));
  assert.ok(!csv.includes('"modeledTotal","0"'));
});

test('T-379 #487: a known zero subtotal with missing quotes remains UNKNOWN overall',()=>{
  const partial=zeroRates();partial.workerCpuMs=null;
  const report=quoteS5Cost(assumptions,partial);
  assert.equal(report.knownSubtotal,0);
  assert.equal(report.componentCosts.workerCpuMs,'UNKNOWN');
  assert.equal(report.modeledTotal,'UNKNOWN');
  assert.equal(report.modeledCostPerUser,'UNKNOWN');
  assert.equal(report.actualProviderBill,'UNKNOWN');
  assert.ok(report.missing.includes('rates.workerCpuMs'));
});

test('T-379 #487: even all-free synthetic quotes do not prove real invoice or hosted capacity',()=>{
  const r=quoteS5Cost(assumptions,zeroRates());
  assert.equal(r.modeledTotal,0);
  assert.equal(r.actualProviderBill,'UNKNOWN');
  assert.equal(r.capacityEvidence.measuredCompletedToolCallsPerDay,'UNKNOWN');
  assert.equal(r.freeThresholdSafeguard.numericThresholdsFit,false);
  assert.equal(r.freeThresholdSafeguard.zeroExtraInvoiceProven,false);
});

test('T-379 #487: CLI output separates historical partial estimate from actual provider evidence',()=>{
  const defaults=JSON.parse(renderS5CostReport([]));
  assert.equal(defaults.actualProviderBill,'UNKNOWN');
  assert.equal(defaults.limitationsEvidence.providerInvoiceStatus,'UNKNOWN');
  for(const s of defaults.scenarios){
    assert.match(s.embeddedRateWarning,/Historical hypothetical partial estimate/);
    assert.equal(s.report.modeledTotal,'UNKNOWN');
    assert.equal(s.report.actualProviderBill,'UNKNOWN');
  }
  const dir=mkdtempSync(join(tmpdir(),'k11-unpriced-provider-'));
  try{
    const file=join(dir,'scenario.json');
    writeFileSync(file,JSON.stringify({label:'unpriced provider',assumptions,rates:{}}));
    const custom=JSON.parse(renderS5CostReport(['--input',file]));
    assert.equal(custom.scenarios[0].report.modeledTotal,'UNKNOWN');
    assert.equal(custom.scenarios[0].report.actualProviderBill,'UNKNOWN');
    assert.equal(custom.scenarios[0].embeddedRateWarning,undefined);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
