import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  quoteS5Cost,estimateS5Cost,formatS5CostCsv,S5_ASSUMPTION_DEFAULTS,
  S5_COST_METERS,type S5RateQuotes,
} from '../../../src/ops/scale-s5-cost-envelope.js';

type Case={id:string;unitLabel:'KiB'|'kB'|'MiB';bytesPerCall:number;
  callsPerUserDaily:number;days:number;expectedDailyRelayGiBApprox:number;
  expectedMonthlyWorkerRequests:string};
const fixture=JSON.parse(readFileSync(new URL('./s5-unit-cases.json',import.meta.url),'utf8')) as {
  schema:string;evidenceKind:string;cases:Case[];
};
const zeroQuotes=():S5RateQuotes=>Object.fromEntries(S5_COST_METERS.map(m=>[
  m,{amount:0,per:1,currency:'USD',source:'synthetic zero rate',
    unit:m==='workerRequests'?'request':m==='workerCpuMs'?'cpu-ms':m==='monthlyBase'?'month':'row'},
])) as S5RateQuotes;

test('T-242: committed JSON fixture distinguishes decimal kB and binary KiB/MiB',()=>{
  assert.equal(fixture.schema,'k11-canonical-s5-units-v1');
  assert.equal(fixture.evidenceKind,'synthetic-offline-not-provider-meter');
  assert.deepEqual(fixture.cases.map(c=>c.unitLabel),['KiB','kB','MiB']);
  assert.equal(fixture.cases.length,3);
  for(const c of fixture.cases){
    assert.ok(['KiB','kB','MiB'].includes(c.unitLabel));
    const x={...S5_ASSUMPTION_DEFAULTS,activeUsers:1,
      callsPerUserDaily:c.callsPerUserDaily,days:c.days,
      workerRequestsPerCall:1,controlRequestsPerUserDaily:0,
      reconnectionsPerUserDaily:0,connectionsPerUser:0,retryBasisPoints:0,
      workerCpuMsPerRequest:1,d1ReadsPerCall:1,d1WritesPerCall:1,
      relayBytesPerCall:c.bytesPerCall,relayFractionBasisPoints:10000};
    const estimate=estimateS5Cost(x);
    assert.equal(estimate.daily.relayGiBApprox,c.expectedDailyRelayGiBApprox,c.id);
    assert.equal(estimate.monthly.workerRequests,c.expectedMonthlyWorkerRequests,c.id);
  }
});

test('T-242: canonical JSON and CSV agree on monthly usage, units and UNKNOWN bill',()=>{
  const rows=fixture.cases.map(c=>{
    const x={...S5_ASSUMPTION_DEFAULTS,activeUsers:1,
      callsPerUserDaily:c.callsPerUserDaily,days:c.days,
      workerRequestsPerCall:1,controlRequestsPerUserDaily:0,
      reconnectionsPerUserDaily:0,connectionsPerUser:0,retryBasisPoints:0,
      workerCpuMsPerRequest:1,d1ReadsPerCall:1,d1WritesPerCall:1,
      relayBytesPerCall:c.bytesPerCall,relayFractionBasisPoints:10000};
    return {label:c.id,activeUsers:1,report:quoteS5Cost(x,zeroQuotes())};
  });
  const json=JSON.parse(JSON.stringify(rows)) as typeof rows;
  const csv=formatS5CostCsv(rows);
  const [header,...body]=csv.trimEnd().split('\n');
  assert.ok(header?.includes('"monthlyWorkerRequests"'));
  assert.ok(header?.includes('"monthlyWorkerCpuMs"'));
  assert.equal(body.length,fixture.cases.length);
  for(let i=0;i<fixture.cases.length;i++){
    const c=fixture.cases[i]!;
    const r=json[i]!.report;
    assert.notEqual(r.monthlyUsage,'UNKNOWN');
    if(r.monthlyUsage==='UNKNOWN')throw Error('Expected monthly usage');
    assert.equal(r.monthlyUsage.workerRequests,c.expectedMonthlyWorkerRequests);
    assert.equal(r.modeledTotal,0);
    assert.equal(r.actualProviderBill,'UNKNOWN');
    assert.ok(body[i]!.startsWith('"'+c.id+'"'));
    assert.ok(body[i]!.includes('"'+c.expectedMonthlyWorkerRequests+'"'));
    assert.ok(body[i]!.includes('"UNKNOWN"'));
  }
});
