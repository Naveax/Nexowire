/**
 * S5 #15: real #598 Express parser, CI-only full boundary.
 * Four deterministic 9.5MiB JSON POST bodies plus 64 tiny POSTs.
 * Source-only localhost. Never contact Hub, Agent, native WSS, Cloudflare or VM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {statfsSync} from 'node:fs';
import {freemem} from 'node:os';
import {createHash} from 'node:crypto';
import {runS5RealParserSeeded,S5_SEED}
  from '../scripts/bench-s5-real-598-seeded.js';
import {NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES}
  from '../src/mcp/http-app.js';

const GIB=1024*1024*1024;
const MAX_RSS_DELTA=256*1024*1024;

test('S5 CI-only real #598 parser: 4x9.5MiB fixed seeded uploads plus 64 tiny requests and gzip admission',
  {timeout:90000},async t=>{
    if(process.env.CI!=='true'){
      t.skip('full 38MiB parser case runs only in isolated hosted CI');
      return;
    }
    const fs=statfsSync(process.cwd());
    const freeDisk=fs.bavail*fs.bsize;
    const freeMemory=freemem();
    if(freeDisk<2*GIB||freeMemory<3*GIB){
      t.diagnostic('S5_FULL_BOUNDARY_PREFLIGHT_BLOCKED '+JSON.stringify({
        freeDiskBytes:freeDisk,freeMemoryBytes:freeMemory,
        requiredDiskBytes:2*GIB,requiredMemoryBytes:3*GIB,
      }));
      t.skip('insufficient sandbox capacity: no full-boundary payload generated');
      return;
    }
    const result=await runS5RealParserSeeded({
      bodyBytes:NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES,
      smallRequests:64,
      rssGrowthLimitBytes:MAX_RSS_DELTA,
    });
    assert.equal(result.kind,'S5_REAL_598_EXPRESS_LOCAL_PARSER_NO_NATIVE');
    assert.equal(result.seed,S5_SEED);
    assert.equal(result.sourceBodyBytes,9_961_472);
    assert.equal(result.largeCount,4);
    assert.equal(result.largeSuccesses,4);
    assert.equal(result.receivedBytes,4*9_961_472);
    assert.equal(result.smallSuccesses,64);
    assert.equal(result.smallDuringLarge,64);
    assert.deepEqual({
      fifth:result.fifthBusy503,
      gzipBusy:result.gzipBusy503,
      gzipRecovered:result.gzipAfterRelease200,
      gzipInflateDenied:result.gzipInflatedOversize413,
    },{fifth:1,gzipBusy:1,gzipRecovered:1,gzipInflateDenied:1});
    assert.equal(result.largeSha256.length,4);
    assert.equal(new Set(result.largeSha256).size,4);
    assert.ok(result.largeSha256.every(x=>/^[a-f0-9]{64}$/.test(x)));
    // A deterministic aggregate digest fingerprints the actual four receiver
    // hashes for this source/seed/size. Timings and CPU are NOT deterministic.
    const fingerprint=createHash('sha256')
      .update(result.largeSha256.join('\n')).digest('hex');
    assert.match(fingerprint,/^[a-f0-9]{64}$/);
    assert.ok(result.backpressureDrainEvents>0);
    assert.ok(result.rssGrowthPeakBytes<=MAX_RSS_DELTA);
    assert.ok(result.cpuUserUs>=0&&result.cpuSystemUs>=0);
    assert.equal(result.smallLatency.method,'nearest-rank');
    assert.equal(result.smallLatency.successN,64);
    assert.equal(result.smallLatency.attemptedN,64);
    assert.equal(result.largeLatency.successN,4);
    assert.equal(result.largeLatency.p95,result.largeLatency.p99,
      'for N=4, nearest rank p95/p99 both select slowest completed request');
    assert.ok(result.smallLatency.p99>=result.smallLatency.p95);
    assert.ok(result.smallLatency.p95>=result.smallLatency.p50);
    assert.equal(result.authenticatedPublicWss,0);
    assert.equal(result.actualNativeToolCompletions,0);
    assert.equal(result.oneGiBPhysicalFiles,0);
    assert.equal(result.actualCloudflareCost,null);
    assert.equal(result.productionAcceptance,'NO_GO');
    process.stdout.write('S5_598_FULL_4X9_5MIB_CI_SOURCE '+JSON.stringify({
      sourceHead:process.env.GITHUB_SHA??'UNAVAILABLE',
      seed:result.seed,bodyBytesEach:result.sourceBodyBytes,
      receivedBytes:result.receivedBytes,largeCount:result.largeCount,
      tinySuccessN:result.smallSuccesses,
      tinyP50Ms:result.smallLatency.p50,
      tinyP95Ms:result.smallLatency.p95,
      tinyP99Ms:result.smallLatency.p99,
      largeSuccessN:result.largeLatency.successN,
      largeP50Ms:result.largeLatency.p50,
      largeP95Ms:result.largeLatency.p95,
      largeP99Ms:result.largeLatency.p99,
      percentile:'nearest-rank over successful request completions; performance.now request initiation to fully read reply',
      contentDigest:fingerprint,chunkProducerMaxBytes:65536,
      gzipBusy503:result.gzipBusy503,
      afterReleaseGzip200:result.gzipAfterRelease200,
      gzipInflatedOverLimit413:result.gzipInflatedOversize413,
      fifthLargeBusy503:result.fifthBusy503,
      backpressureDrainEvents:result.backpressureDrainEvents,
      peakRssGrowthBytes:result.rssGrowthPeakBytes,
      cpuUserUs:result.cpuUserUs,cpuSystemUs:result.cpuSystemUs,
      wallDurationMs:result.wallDurationMs,
      nativeCompletionsVerified:0,publicAuthenticatedWss:0,
      cloudflareActualBilling:null,physicalOneGiB:false,
      productionAcceptance:'NO_GO',
    })+'\n');
  });

test('S5 capacity boundary cannot accept 1GiB or unbounded 100+ request dimensions',
  async()=>{
    await assert.rejects(runS5RealParserSeeded({
      bodyBytes:1024*1024*1024,smallRequests:64,
    }),/S5_UNBOUNDED_BODY/);
    await assert.rejects(runS5RealParserSeeded({
      bodyBytes:9_961_472,smallRequests:101,
    }),/S5_UNBOUNDED_SMALL_REQUESTS/);
    await assert.rejects(runS5RealParserSeeded({
      bodyBytes:9_961_472,smallRequests:64,
      rssGrowthLimitBytes:1024*1024*1024,
    }),/S5_UNBOUNDED_RSS/);
  });
