/** Offline, bounded localhost-only S5 fixture contracts. Not provider or native acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runS5LoopbackLoad,summarizeS5Latencies,
} from '../../../scripts/bench-s5-loopback-ws-capacity.js';
import {runS5ReconnectStorm} from '../../../scripts/bench-s5-loopback-reconnect-storm.js';

test('T-069 nearest-rank percentiles retain singleton and cold-sample boundaries',()=>{
  assert.deepEqual(summarizeS5Latencies([1.23456]),
    {p50:1.235,p95:1.235,p99:1.235,max:1.235});
  assert.deepEqual(summarizeS5Latencies([40,10,20,30]),
    {p50:20,p95:40,p99:40,max:40});
  assert.deepEqual(summarizeS5Latencies([1,2]),{p50:1,p95:2,p99:2,max:2});
});

test('T-069/T-070 no empty, zero, negative, NaN or infinite timing is accepted',()=>{
  for(const bad of [[],[0],[-1],[1,Number.NaN],[1,Infinity],[1,-Infinity]]){
    assert.throws(()=>summarizeS5Latencies(bad),/non-empty finite positive/);
  }
});

test('T-067/T-071 capacity result is typed, serializable, balanced and explicitly synthetic',
  {timeout:30000},async()=>{
    const r=await runS5LoopbackLoad({clients:2,callsPerClient:1,mode:'isolated'});
    assert.equal(r.kind,'SYNTHETIC_LOOPBACK_WS_OWNER_SQLITE');
    assert.equal(r.mode,'isolated');
    assert.equal(r.clients,2);
    assert.equal(r.callsPerClient,1);
    assert.deepEqual(r.sockets,{connected:2,peak:2,closed:2});
    assert.equal(r.rpc.attempted,4);
    assert.equal(r.rpc.reserved,2);
    assert.equal(r.rpc.duplicate,2);
    assert.equal(r.rpc.rateLimited+r.rpc.backpressure+r.rpc.other,0);
    assert.equal(r.rpc.attempted,r.rpc.reserved+r.rpc.duplicate+
      r.rpc.rateLimited+r.rpc.backpressure+r.rpc.other);
    assert.deepEqual(r.ledger,{rows:2,dailyUsed:2,toolExecutions:0});
    assert.equal(r.fairness.jainIndex,1);
    assert.deepEqual(Object.keys(r.latencyMs),['p50','p95','p99','max']);
    assert.ok(r.latencyMs.p50>=0&&r.latencyMs.p95>=r.latencyMs.p50);
    assert.ok(r.latencyMs.p99>=r.latencyMs.p95&&r.latencyMs.max>=r.latencyMs.p99);
    assert.ok(r.elapsedMs>0&&r.rpc.perSecond>=0);
    assert.ok(r.ioBytes.sqlite>0&&r.ioBytes.received>0&&r.ioBytes.sent>0);
    assert.ok(r.memoryBytes.rssStart>0&&r.memoryBytes.rssPeak>=r.memoryBytes.rssStart);
    assert.ok(r.constraints.some(x=>x.includes('loopback')));
    assert.ok(r.constraints.some(x=>x.includes('24h soak NOT RUN')));
    // The JSON contract must not silently convert NaN/Infinity to null.
    const serialized=JSON.stringify(r);
    assert.deepEqual(JSON.parse(serialized),r);
    const numbers=(value:unknown):void=>{
      if(typeof value==='number')assert.ok(Number.isFinite(value));
      else if(value&&typeof value==='object'){
        for(const entry of Object.values(value))numbers(entry);
      }
    };
    numbers(r);
  });

test('T-070 invalid workloads fail before opening a localhost socket',async()=>{
  for(const opts of [
    {clients:0},{clients:-1},{clients:NaN},{clients:Infinity},
    {clients:1,callsPerClient:0},{clients:1,callsPerClient:-1},
    {clients:1,maxInFlight:0},{clients:1,queueCap:0},
    {clients:1,minuteLimit:0},{clients:1,dailyLimit:0},
  ]){
    await assert.rejects(runS5LoopbackLoad(opts),/outside/);
  }
});

test('T-068/T-072 reconnect churn respects bounds and never claims native success',
  {timeout:30000},async()=>{
    const r=await runS5ReconnectStorm({socketsPerRound:2,rounds:2,queueLimit:4,
      processingLimit:2});
    assert.equal(r.kind,'SYNTHETIC_LOOPBACK_WS_NO_REAL_NATIVE_TOOL');
    assert.equal(r.opened,4);
    assert.equal(r.closed,4);
    assert.equal(r.requests,4);
    assert.equal(r.uniqueReservations,2);
    assert.equal(r.duplicates,2);
    assert.equal(r.backpressure,0);
    assert.equal(r.requests,r.uniqueReservations+r.duplicates+r.backpressure);
    assert.ok(r.peakQueue<=4&&r.peakProcessing<=2);
    assert.deepEqual({reported:r.reportedNativeCompleted,verified:r.verifiedNativeCompleted},
      {reported:0,verified:0});
    assert.ok(r.latencyMs.p50>=0&&r.latencyMs.p99>=r.latencyMs.p95);
    assert.deepEqual(JSON.parse(JSON.stringify(r)),r);
  });

test('T-068/T-070 reconnect rejects out-of-budget dimensions',async()=>{
  for(const dimensions of [
    {socketsPerRound:0,rounds:1,queueLimit:1,processingLimit:1},
    {socketsPerRound:-1,rounds:1,queueLimit:1,processingLimit:1},
    {socketsPerRound:1,rounds:0,queueLimit:1,processingLimit:1},
    {socketsPerRound:1,rounds:1,queueLimit:0,processingLimit:1},
    {socketsPerRound:1,rounds:1,queueLimit:1,processingLimit:0},
    {socketsPerRound:Infinity,rounds:1,queueLimit:1,processingLimit:1},
  ])await assert.rejects(runS5ReconnectStorm(dimensions),/safety limits/);
});

test('T-068 pre-cancelled storm rejects without networking',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(runS5ReconnectStorm({socketsPerRound:1,rounds:1,
    queueLimit:1,processingLimit:1,signal:controller.signal}),/aborted/);
});

test('T-068 in-flight cancellation shuts down the owned sockets promptly',
  {timeout:5000},async()=>{
    const controller=new AbortController();
    const result=runS5ReconnectStorm({socketsPerRound:96,rounds:3,queueLimit:16,
      processingLimit:2,signal:controller.signal});
    queueMicrotask(()=>controller.abort());
    await assert.rejects(result,/aborted/);
  });
