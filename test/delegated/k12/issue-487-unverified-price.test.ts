/** T-379 / #487: local S5 benchmark observations cannot establish a provider bill. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {runS5LoopbackLoad} from '../../../scripts/bench-s5-loopback-ws-capacity.js';
import {summarizeS5ScenarioResults} from '../../../scripts/report-s5-measured-scenarios.js';
import {
  S5_ASSUMPTION_DEFAULTS,formatS5CostCsv,projectS5Matrix,quoteS5Cost,
  type S5RateQuotes,
} from '../../../src/ops/scale-s5-cost-envelope.js';

test('observed loopback reservations cannot become provider capacity or a price',async()=>{
  const local=await runS5LoopbackLoad({clients:2,callsPerClient:1,mode:'isolated'});
  assert.equal(local.kind,'SYNTHETIC_LOOPBACK_WS_OWNER_SQLITE');
  assert.equal(local.rpc.reserved,2);
  assert.equal(local.ledger.toolExecutions,0);
  const summary=summarizeS5ScenarioResults([local]);
  assert.equal(summary.measurementClassification,'LOCAL_SYNTHETIC_ONLY');
  assert.equal(summary.capacityEstimate,null);
  assert.equal(summary.providerCapacityProven,false);

  // This deliberately maps a measured local client count to an *assumed*
  // commercial workload. Even complete local counter data supplies no rates.
  const quoted=quoteS5Cost({...S5_ASSUMPTION_DEFAULTS,activeUsers:local.clients});
  assert.equal(quoted.classification,'OFFLINE_SIMULATION_NOT_PROVIDER_BILL');
  assert.equal(quoted.currency,'UNKNOWN');
  assert.equal(quoted.knownSubtotal,'UNKNOWN');
  assert.equal(quoted.modeledTotal,'UNKNOWN');
  assert.equal(quoted.modeledCostPerUser,'UNKNOWN');
  assert.equal(quoted.actualProviderBill,'UNKNOWN');
  assert.equal(quoted.freeThresholdSafeguard.zeroExtraInvoiceProven,false);
  assert.ok(quoted.missing.some(field=>field==='rates.workerRequests'));
  assert.ok(Object.values(quoted.componentCosts).every(value=>value==='UNKNOWN'));
});

test('partial provider-rate fixtures may yield a subtotal, never a complete bill',()=>{
  const partial:S5RateQuotes={workerRequests:{amount:0.3,per:1_000_000,
    unit:'request',currency:'USD',source:'offline-example-only'}};
  const quoted=quoteS5Cost(S5_ASSUMPTION_DEFAULTS,partial);
  assert.equal(quoted.currency,'USD');
  assert.equal(typeof quoted.knownSubtotal,'number');
  assert.equal(quoted.modeledTotal,'UNKNOWN');
  assert.equal(quoted.modeledCostPerUser,'UNKNOWN');
  assert.equal(quoted.actualProviderBill,'UNKNOWN');
  assert.equal(quoted.freeThresholdSafeguard.zeroExtraInvoiceProven,false);
  assert.ok(quoted.missing.includes('rates.monthlyBase'));
  const csv=formatS5CostCsv([{label:'2 local users / assumed rates',activeUsers:2,
    report:quoted}]);
  const [header,row]=csv.trimEnd().split('\n');
  const columns=header!.match(/"(?:[^"]|"")*"/g)!.map(c=>c.slice(1,-1));
  const cells=row!.match(/"(?:[^"]|"")*"/g)!.map(c=>c.slice(1,-1));
  assert.equal(cells[columns.indexOf('modeledTotal')],'UNKNOWN');
  assert.equal(cells[columns.indexOf('actualProviderBill')],'UNKNOWN');
  assert.equal(cells[columns.indexOf('classification')],
    'OFFLINE_SIMULATION_NOT_PROVIDER_BILL');
});

test('numerical offline matrix projections never claim zero extra provider invoice',()=>{
  const projected=projectS5Matrix();
  assert.ok(projected.length>0);
  for(const row of projected){
    assert.equal(row.classification,'OFFLINE_PROJECTION_NOT_PROVIDER_METER');
    assert.equal(row.freeEnvelope.zeroExtraInvoiceProven,false,row.label);
    assert.ok(row.freeEnvelope.excludedFactors.length>0,row.label);
    assert.ok(row.paidPartialUsd.excludedFactors.length>0,row.label);
    assert.equal(typeof row.paidPartialUsd.totalExcludingUnknown,'number',row.label);
  }
});

test('missing assumptions cannot be inferred from successful local counts',()=>{
  const quoted=quoteS5Cost({activeUsers:2,callsPerUserDaily:1});
  assert.equal(quoted.monthlyUsage,'UNKNOWN');
  assert.equal(quoted.knownSubtotal,'UNKNOWN');
  assert.equal(quoted.modeledTotal,'UNKNOWN');
  assert.equal(quoted.actualProviderBill,'UNKNOWN');
  assert.ok(quoted.missing.includes('assumptions.workerRequestsPerCall'));
  assert.equal(quoted.freeThresholdSafeguard.zeroExtraInvoiceProven,false);
});
