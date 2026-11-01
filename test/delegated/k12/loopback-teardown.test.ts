/** T-195..199: synthetic-local-only JSON/teardown regression contracts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {runS5LoopbackLoad,summarizeS5Latencies} from '../../../scripts/bench-s5-loopback-ws-capacity.js';
import {
  runS5ReconnectStorm,type S5StormTeardown,
} from '../../../scripts/bench-s5-loopback-reconnect-storm.js';

const noOpenSockets:Readonly<S5StormTeardown>={
  openClients:0,openServerSockets:0,queued:0,processing:0,
};

function jsonShape(value:unknown):unknown{
  if(Array.isArray(value))return value.map(jsonShape);
  if(value&&typeof value==='object'){
    return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,jsonShape(v)]));
  }
  return typeof value;
}

test('T-195 sub-microsecond but positive latency never formats as zero; empty stays invalid',()=>{
  const tiny=summarizeS5Latencies([0.0000001]);
  assert.deepEqual(tiny,{p50:0.001,p95:0.001,p99:0.001,max:0.001});
  assert.throws(()=>summarizeS5Latencies([]),/non-empty/);
  for(const samples of [[0.000001,0],[-0.01,0.01],[NaN],[Infinity]]){
    assert.throws(()=>summarizeS5Latencies(samples),/finite positive/);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(tiny)),tiny);
});

test('T-196 explicit cancellation leaves zero local socket and queue resources',
  {timeout:6000},async()=>{
    const controller=new AbortController();
    const teardown:S5StormTeardown[]=[];
    const pending=runS5ReconnectStorm({socketsPerRound:96,rounds:3,queueLimit:8,
      processingLimit:1,signal:controller.signal,onTeardown:state=>teardown.push(state)});
    queueMicrotask(()=>controller.abort());
    await assert.rejects(pending,/S5 storm aborted/);
    assert.deepEqual(teardown,[noOpenSockets]);
  });

test('T-197 a 1ms deadline does not leave live local sockets or stale queue work',
  {timeout:6000},async()=>{
    const teardown:S5StormTeardown[]=[];
    const pending=runS5ReconnectStorm({socketsPerRound:128,rounds:3,
      queueLimit:16,processingLimit:1,signal:AbortSignal.timeout(1),
      onTeardown:state=>teardown.push(state)});
    await assert.rejects(pending,/S5 storm aborted/);
    assert.deepEqual(teardown,[noOpenSockets]);
    // A succeeding second run is not proof of OS-wide leak freedom, but does
    // guard a local re-entry regression after a timed-out fixture.
    const next=await runS5ReconnectStorm({socketsPerRound:1,rounds:1,
      queueLimit:1,processingLimit:1});
    assert.equal(next.opened,1);
    assert.equal(next.closed,1);
    assert.equal(next.verifiedNativeCompleted,0);
  });

test('T-198 two identical local scenarios retain JSON structure, not equal numeric timings',
  {timeout:30000},async()=>{
    const a=await runS5LoopbackLoad({clients:1,callsPerClient:1});
    const b=await runS5LoopbackLoad({clients:1,callsPerClient:1});
    assert.deepEqual(jsonShape(JSON.parse(JSON.stringify(a))),
      jsonShape(JSON.parse(JSON.stringify(b))));
    assert.deepEqual(Object.keys(a),Object.keys(b));
    assert.equal(a.rpc.attempted,b.rpc.attempted);
    assert.equal(a.rpc.reserved,b.rpc.reserved);
    assert.equal(a.sockets.closed,b.sockets.closed);
    assert.equal(a.ledger.toolExecutions,0);
    assert.equal(b.ledger.toolExecutions,0);
    // Do not compare dynamic CPU, RSS, p99 or elapsed values across runs.
  });

test('T-199 synthetic loopback counters cannot be labelled real provider/native acceptance',
  {timeout:30000},async()=>{
    const r=await runS5LoopbackLoad({clients:1,callsPerClient:1});
    assert.match(r.kind,/^SYNTHETIC_LOOPBACK_/);
    assert.equal(r.ledger.toolExecutions,0);
    assert.ok(r.constraints.some(x=>/not wss:\/\/, provider\/Cloudflare or real MCP/.test(x)));
    assert.ok(r.constraints.some(x=>/physical success=0; 24h soak NOT RUN/.test(x)));
    const storm=await runS5ReconnectStorm({socketsPerRound:1,rounds:1,
      queueLimit:1,processingLimit:1});
    assert.match(storm.kind,/^SYNTHETIC_LOOPBACK_/);
    assert.equal(storm.reportedNativeCompleted,0);
    assert.equal(storm.verifiedNativeCompleted,0);
    assert.equal(Object.hasOwn(r,'productionAccepted'),false);
    assert.equal(Object.hasOwn(storm,'productionAccepted'),false);
  });
