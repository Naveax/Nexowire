import test from 'node:test';
import assert from 'node:assert/strict';
import {runS5LocalHttpIsolation,S5_HTTP_MAX_BYTES,S5_HTTP_CHUNK_BYTES}
  from '../scripts/bench-s5-http-mcp-isolation.js';
test('four overlapping bounded HTTP uploads do not starve small synthetic MCP route',
  {timeout:30000},async()=>{
    const r=await runS5LocalHttpIsolation({
      largeRequests:4,largeRequestBytes:1024*1024,smallRequests:16,
      perChunkPauseMs:2,runLimitMs:15000,probeFifthRequest:true,
      probeOverLimit:true,
    });
    assert.equal(r.classification,'REAL_LOCAL_HTTP_BYTES_SYNTHETIC_MCP_FIXTURE');
    assert.equal(r.largePeakActive,4);
    assert.equal(r.largeSuccessful,4);
    assert.equal(r.smallSuccessful,16);
    assert.ok(r.smallArrivedDuringLarge>=1);
    assert.equal(r.bytesReceived,4*1024*1024);
    assert.equal(r.http429Count,1);
    assert.equal(r.http413Count,1);
    assert.equal(r.configuredHttpBodyMaxBytes,S5_HTTP_MAX_BYTES);
    assert.ok(r.smallLatencyMs.p99>=r.smallLatencyMs.p95);
    assert.ok(r.largeLatencyMs.p99>=r.largeLatencyMs.p95);
    assert.ok(r.rssGrowthPeakBytes<=r.memoryBudgetBytes);
    assert.equal(r.receivedHashes.length,4);
    assert.ok(r.receivedHashes.every(h=>/^[a-f0-9]{64}$/.test(h)));
    assert.equal(r.externalWssAuthenticated,0);
    assert.equal(r.actualNativeToolCompletions,0);
    assert.equal(r.cloudflareMeterReadings,null);
    process.stdout.write('S5_LOCAL_HTTP_MEASURED '+JSON.stringify({
      peakLarge:r.largePeakActive,largeBytesReceived:r.bytesReceived,
      smallRequests:r.smallSuccessful,smallDuringLarge:r.smallArrivedDuringLarge,
      smallP95Ms:r.smallLatencyMs.p95,smallP99Ms:r.smallLatencyMs.p99,
      largeP95Ms:r.largeLatencyMs.p95,largeP99Ms:r.largeLatencyMs.p99,
      tcpBackpressureWrites:r.backpressureWrites,http413:r.http413Count,
      http429:r.http429Count,rssGrowthPeakBytes:r.rssGrowthPeakBytes,
      staging:'NOT_TESTED',actualNativeToolCompletions:0,
    })+'\n');
  });
test('HTTP fixture refuses fifth source-concurrency slot and unbounded workload',
  async()=>{
    for(const bad of [
      {largeRequests:5},{largeRequests:0},{largeRequests:4,largeRequestBytes:S5_HTTP_MAX_BYTES+1},
      {smallRequests:33},{runLimitMs:3600000},{rssGrowthBudgetBytes:1024*1024*1024},
    ])await assert.rejects(runS5LocalHttpIsolation(bad),/S5 bounded input/);
    assert.equal(S5_HTTP_CHUNK_BYTES,65536);
  });
