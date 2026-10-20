import test from 'node:test';
import assert from 'node:assert/strict';
import {runS5ReconnectStorm} from '../scripts/bench-s5-loopback-reconnect-storm.js';
test('S5 120 loopback WS users reconnect three times without duplicate tool admission',
  {timeout:90000},async()=>{
    const r=await runS5ReconnectStorm({socketsPerRound:120,rounds:3,queueLimit:32,processingLimit:4});
    assert.equal(r.opened,360);assert.equal(r.closed,360);
    assert.equal(r.requests,360);
    // Peer-close delivery can lag the next dial batch on Windows loopback.
    assert.ok(r.peakOpen>=12&&r.peakOpen<=24);
    assert.ok(r.uniqueReservations<=120);
    assert.ok(r.duplicates>=120); // replay was received and recognized
    assert.equal(r.requests,r.uniqueReservations+r.duplicates+r.backpressure);
    assert.equal(r.reportedNativeCompleted,0);
    assert.equal(r.verifiedNativeCompleted,0);
    assert.ok(r.latencyMs.p99>=r.latencyMs.p95);
    assert.ok(r.peakProcessing<=4);
    assert.ok(r.peakQueue<=32);
  });
test('S5 tiny queue induces explicit backpressure rather than silent success',
  {timeout:60000},async()=>{
    const r=await runS5ReconnectStorm({socketsPerRound:120,rounds:1,queueLimit:1,processingLimit:1});
    assert.ok(r.backpressure>0);
    assert.equal(r.requests,r.uniqueReservations+r.duplicates+r.backpressure);
    assert.equal(r.verifiedNativeCompleted,0);
    assert.ok(r.peakQueue<=1);
  });
test('S5 reconnect fixture rejects unbounded load dimensions',async()=>{
  for(const inputs of [
    {socketsPerRound:129,rounds:1,queueLimit:1,processingLimit:1},
    {socketsPerRound:120,rounds:4,queueLimit:1,processingLimit:1},
    {socketsPerRound:120,rounds:1,queueLimit:129,processingLimit:1},
  ])await assert.rejects(runS5ReconnectStorm(inputs));
});
