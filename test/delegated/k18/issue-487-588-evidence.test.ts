import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  summarizeOfflineTransferProgress,
  parseScaleTransportMetricRows,
  safelyParseScaleTransportMetricRows,
} from '../../../src/ops/scale-transport-metrics.js';
import {summarizeS5ScenarioResults} from '../../../scripts/report-s5-measured-scenarios.js';
import type {S5LoadResult} from '../../../scripts/bench-s5-loopback-ws-capacity.js';

const fixture=JSON.parse(readFileSync(
  new URL('./transfer-byte-evidence.json',import.meta.url),'utf8',
)) as {schema:string;origin:string;unit:string;cases:Array<Record<string,unknown>>};

test('T-358 #588 sent bytes reaching total cannot claim 100% transfer',()=>{
  const partial=summarizeOfflineTransferProgress({
    phase:'PARTIAL',totalBytes:226304,sentBytes:226304,
    receivedBytes:226304,acknowledgedBytes:225280,finalReceiptVerified:false,
  });
  assert.equal(partial.complete,false);
  assert.notEqual(partial.progressPercent,100);
  const uncommitted=summarizeOfflineTransferProgress({
    phase:'COMPLETE',totalBytes:226304,sentBytes:226304,
    receivedBytes:226304,acknowledgedBytes:226304,finalReceiptVerified:false,
  });
  assert.equal(uncommitted.progressPercent,99);
  assert.equal(uncommitted.complete,false);
});

test('T-358 #588 only complete state plus matching ack and verified receipt can show 100%',()=>{
  const valid=summarizeOfflineTransferProgress({
    phase:'COMPLETE',totalBytes:226304,sentBytes:226304,
    receivedBytes:226304,acknowledgedBytes:226304,finalReceiptVerified:true,
  });
  assert.equal(valid.progressPercent,100);
  assert.equal(valid.complete,true);
  assert.equal(valid.classification,'SYNTHETIC_EVIDENCE_ONLY');
  const wrongState=summarizeOfflineTransferProgress({
    phase:'INTERRUPTED',totalBytes:226304,sentBytes:226304,
    receivedBytes:226304,acknowledgedBytes:226304,finalReceiptVerified:true,
  });
  assert.equal(wrongState.complete,false);
  assert.equal(wrongState.progressPercent,99);
});

test('T-359 #487 NaN/Infinity/negative/strings stay UNKNOWN, never observed zero',()=>{
  const clean={name:'agent.rx_frames',events:1,bytes:128,
    eventsUnit:'count',bytesUnit:'bytes'};
  for(const value of [NaN,Infinity,-Infinity,-1,'128']){
    assert.throws(()=>parseScaleTransportMetricRows([{...clean,bytes:value}]));
    const safe=safelyParseScaleTransportMetricRows([{...clean,bytes:value}]);
    assert.equal(safe['agent.rx_frames'].classification,'UNKNOWN');
    assert.equal(safe['agent.rx_frames'].events,null);
    assert.equal(safe['agent.rx_frames'].bytes,null);
  }
});

test('T-360 #487 zero observations cannot manufacture a capacity confidence interval',()=>{
  const empty=summarizeS5ScenarioResults([]);
  assert.equal(empty.measurementClassification,'UNKNOWN');
  assert.equal(empty.capacityEstimate,null);
  assert.equal(empty.capacityConfidenceInterval,null);
  const synthetic={kind:'SYNTHETIC_LOOPBACK_WS_OWNER_SQLITE',clients:1,
    rpc:{attempted:1,reserved:1,backpressure:0},sockets:{peak:1},
    elapsedMs:1,memoryBytes:{rssPeak:1024},fairness:{jainIndex:1},
    latencyMs:{p50:1,p95:1,p99:1,max:1}} as S5LoadResult;
  const measured=summarizeS5ScenarioResults([synthetic]);
  assert.equal(measured.measurementClassification,'LOCAL_SYNTHETIC_ONLY');
  assert.equal(measured.capacityEstimate,null);
  assert.equal(measured.capacityConfidenceInterval,null);
  assert.equal(measured.providerCapacityProven,false);
});

test('T-361 #487 output is explicit JSON-only proof, no CSV success claim',()=>{
  const json=JSON.stringify(summarizeS5ScenarioResults([]));
  assert.match(json,/"measurementClassification":"UNKNOWN"/);
  assert.match(json,/"capacityEstimate":null/);
  assert.match(json,/"capacityConfidenceInterval":null/);
  assert.equal(json.includes('csvValidated'),false);
});

test('T-362 #588 synthetic sizes keep sent/received/acknowledged distinct',()=>{
  assert.equal(fixture.schema,'nexowire-k18-synthetic-transfer-bytes-v1');
  assert.equal(fixture.origin,'SYNTHETIC_ONLY_NO_LIVE_DEVICE_OR_TRANSFER');
  assert.equal(fixture.unit,'bytes');
  assert.deepEqual(fixture.cases.map(c=>c.totalBytes),
    [226304,1048576,268435457,1073741824]);
  const summaries=fixture.cases.map(c=>summarizeOfflineTransferProgress(c));
  assert.equal(summaries[0]!.phase,'INTERRUPTED');
  assert.equal(summaries[0]!.complete,false);
  assert.notEqual(summaries[0]!.sentBytes,summaries[0]!.acknowledgedBytes);
  assert.equal(summaries[1]!.progressPercent,100);
  assert.equal(summaries[1]!.complete,true);
  assert.equal(summaries[2]!.sentBytes,314572800); // Retried bytes > total.
  assert.equal(summaries[2]!.acknowledgedBytes,209715200);
  assert.ok(summaries[2]!.progressPercent!<100);
  assert.equal(summaries[3]!.progressPercent,99); // All bytes seen; no commit.
  assert.equal(summaries[3]!.complete,false);
});

test('T-362 #588 invalid or missing counters cannot become fabricated progress',()=>{
  const valid=fixture.cases[0]!;
  for(const patch of [
    {acknowledgedBytes:226305}, {receivedBytes:Infinity},
    {sentBytes:-1}, {totalBytes:NaN}, {acknowledgedBytes:undefined},
    {phase:'COMPLETED'}, {finalReceiptVerified:'true'},
  ]){
    const result=summarizeOfflineTransferProgress({...valid,...patch});
    assert.equal(result.classification,'UNKNOWN');
    assert.equal(result.progressPercent,null);
    assert.equal(result.complete,false);
  }
});
