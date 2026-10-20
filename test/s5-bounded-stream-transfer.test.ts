import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runS5LocalStreamLoad,S5_LOCAL_221_KIB,
  S5_LOCAL_1_GIB,S5_LOCAL_CHUNK_BYTES,
} from '../scripts/bench-s5-bounded-stream-transfer.js';
test('S5/#588 221-KiB real bytes cross localhost TCP and roundtrip SHA matches',
  {timeout:15000},async()=>{
    const result=await runS5LocalStreamLoad({sizesBytes:[S5_LOCAL_221_KIB],
      deadlineMs:8000,maxRssGrowthBytes:64*1024*1024});
    assert.equal(result.samples.length,1);
    const v=result.samples[0]!;
    assert.equal(v.receivedBytes,221*1024);
    assert.equal(v.requestedBytes,v.transmittedBytes);
    assert.equal(v.senderSha256,v.receiverSha256);
    assert.ok(v.emittedChunks>=4);
    assert.ok(v.throughputMiBps>0);
    assert.equal(result.stagingWssConnections,0);
    assert.equal(result.nativeToolCompletions,0);
    assert.equal(result.diskFileBytesCreated,0);
    assert.equal(v.actualArtifactStoreCommit,false);
    assert.equal(result.externalNetworkRequests,0);
  });
test('S5/#588 two independent real loopback byte streams have bounded concurrency and buffers',
  {timeout:20000},async()=>{
    const result=await runS5LocalStreamLoad({sizesBytes:[4*1024*1024,S5_LOCAL_221_KIB],
      maxConcurrent:2,deadlineMs:10000,maxRssGrowthBytes:96*1024*1024});
    assert.equal(result.peakActiveTransfers,2);
    assert.equal(result.samples.reduce((sum,s)=>sum+s.receivedBytes,0),4*1024*1024+221*1024);
    for(const v of result.samples){
      assert.equal(v.senderSha256,v.receiverSha256);
      assert.ok(v.maxSocketWritableLengthBytes<=S5_LOCAL_CHUNK_BYTES);
      assert.equal(v.completedNativeTools,0);
    }
    assert.equal(result.providerCountersMeasured,false);
  });
test('S5/#588 an oversized payload, >2 streams, zero-byte chunk and unbounded deadlines are refused',
  async()=>{
    for(const x of [
      {sizesBytes:[S5_LOCAL_1_GIB+1]},
      {sizesBytes:[1,2,3,4]},
      {sizesBytes:[1024],maxConcurrent:3},
      {sizesBytes:[1024],chunkBytes:0},
      {sizesBytes:[1024],deadlineMs:1000000},
      {sizesBytes:[1024],maxRssGrowthBytes:Number.POSITIVE_INFINITY},
    ])await assert.rejects(runS5LocalStreamLoad(x),/Invalid|Unbounded/);
  });
