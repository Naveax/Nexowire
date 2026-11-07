import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  parseScaleTransportMetricRows,
  safelyParseScaleTransportMetricRows,
} from '../../../src/ops/scale-transport-metrics.js';
import {summarizeS5ScenarioResults} from '../../../scripts/report-s5-measured-scenarios.js';
import type {S5LoadResult} from '../../../scripts/bench-s5-loopback-ws-capacity.js';

type UnitCase={label:string;bytes:number;decimalKB:number;binaryKiB:number;binaryMiB:number};
const fixture=JSON.parse(readFileSync(new URL('./byte-unit-cases.json',import.meta.url),'utf8')) as {
  schema:string;origin:string;storageUnit:string;cases:UnitCase[];
};

test('T-384 #487 decimal KB and binary KiB/MiB are separate, exact columns',()=>{
  assert.equal(fixture.schema,'nexowire-k18-byte-unit-cases-v1');
  assert.equal(fixture.origin,'SYNTHETIC_ONLY');
  assert.equal(fixture.storageUnit,'bytes');
  for(const item of fixture.cases){
    assert.equal(item.decimalKB,item.bytes/1000,item.label);
    assert.equal(item.binaryKiB,item.bytes/1024,item.label);
    assert.equal(item.binaryMiB,item.bytes/1048576,item.label);
  }
  assert.equal(fixture.cases[0]!.bytes,1000);
  assert.equal(fixture.cases[1]!.bytes,1024);
  assert.notEqual(fixture.cases[0]!.binaryKiB,fixture.cases[1]!.binaryKiB);
});

test('T-384 #487 220 KiB is not silently relabeled as 220 decimal KB',()=>{
  const item=fixture.cases.find(x=>x.label==='220 KiB')!;
  assert.equal(item.bytes,225280);
  assert.equal(item.binaryKiB,220);
  assert.equal(item.decimalKB,225.28);
  assert.notEqual(item.decimalKB,item.binaryKiB);
});

test('T-384 #487 transport parser rejects mislabeled KB/KiB/MiB counter units',()=>{
  const raw={name:'agent.rx_frames',events:1,bytes:225280,
    eventsUnit:'count',bytesUnit:'bytes'};
  assert.equal(parseScaleTransportMetricRows([raw])['agent.rx_frames'].bytes,225280);
  for(const wrongUnit of ['KB','KiB','MiB','MB','kilobytes','unknown']){
    const sample=[{...raw,bytesUnit:wrongUnit}];
    assert.throws(()=>parseScaleTransportMetricRows(sample),/units/);
    const safe=safelyParseScaleTransportMetricRows(sample);
    assert.equal(safe['agent.rx_frames'].classification,'UNKNOWN');
    assert.equal(safe['agent.rx_frames'].bytes,null);
  }
});

test('T-384 #487 S5 JSON keeps RSS byte unit and raw count, no inferred MiB',()=>{
  for(const item of fixture.cases){
    const scenario={kind:'SYNTHETIC_LOOPBACK_WS_OWNER_SQLITE',clients:1,
      rpc:{attempted:1,reserved:1,backpressure:0},sockets:{peak:1},
      elapsedMs:1,memoryBytes:{rssPeak:item.bytes},fairness:{jainIndex:1},
      latencyMs:{p50:1,p95:1,p99:1,max:1}} as S5LoadResult;
    const result=summarizeS5ScenarioResults([scenario]);
    const row=result.scenarios[0]!;
    assert.equal(row.rssPeakBytes,item.bytes);
    assert.equal('rssPeakMiB' in row,false);
    assert.equal(result.capacityEstimate,null);
  }
});
