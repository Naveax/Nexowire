import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {runS5RealParserSeeded,s5NearestRank,S5_SEED}
  from '../scripts/bench-s5-real-598-seeded.js';
import {ProposedS5ProtectedTenantAdmission}
  from '../src/ops/scale-s5-protected-admission.js';

test('#15 nearest-rank p95/p99 fixed samples do not include rejected or imaginary SLO',()=>{
  const valid=[...Array(19).fill(2),100];
  assert.equal(s5NearestRank(valid,.95),2);
  assert.equal(s5NearestRank(valid,.99),100);
  assert.equal(s5NearestRank([1,2,3,4],.95),4);
  assert.equal(S5_SEED,0x5a17c0de);
  assert.throws(()=>s5NearestRank([],0.95),/S5_INVALID_LATENCY_SAMPLE/);
  assert.throws(()=>s5NearestRank([2,Infinity],0.99),/S5_INVALID_LATENCY_SAMPLE/);
});

test('#15 actual #598 Express parser: four fixed-seed 256KiB large POST, tiny identity/gzip fairness',
  {timeout:30000},async()=>{
    const r=await runS5RealParserSeeded({bodyBytes:256*1024});
    assert.equal(r.kind,'S5_REAL_598_EXPRESS_LOCAL_PARSER_NO_NATIVE');
    assert.equal(r.largeSuccesses,4);
    assert.equal(r.receivedBytes,4*256*1024);
    assert.equal(r.smallSuccesses,20);
    assert.equal(r.smallDuringLarge,20);
    assert.equal(r.fifthBusy503,1);
    assert.equal(r.gzipBusy503,1);
    assert.equal(r.gzipAfterRelease200,1);
    assert.equal(r.gzipInflatedOversize413,1);
    assert.equal(r.largeSha256.length,4);
    assert.ok(new Set(r.largeSha256).size===4,'seeded streams should differ by upload index');
    assert.deepEqual(r.largeSha256,[
      'e8c0d99e079ab2e801e92f02b45e72f0381fd05a21b986851fcffbab55e01102',
      '9bc890e1e155000cf7b46d053d4ce70bdbdb9175070ad355ed0c5a003e545bc2',
      '19bbe7a8c5433519e53c28ab90466b62c032764f90781536baac8bcbe49c3bdf',
      '47a81149ff49a4e910322d3f0377d8d39e32ae95c4fa359598344bdc7d1c6615',
    ],'fixed seed + source size must reproduce the exact sender/receiver digests');
    assert.ok(r.largeSha256.every(x=>/^[a-f0-9]{64}$/.test(x)));
    assert.ok(r.rssGrowthPeakBytes<=r.rssGrowthLimitBytes);
    assert.ok(r.cpuUserUs>=0&&r.cpuSystemUs>=0);
    assert.ok(r.smallLatency.p99>=r.smallLatency.p95);
    assert.ok(r.largeLatency.p99>=r.largeLatency.p95);
    assert.equal(r.actualNativeToolCompletions,0);
    assert.equal(r.authenticatedPublicWss,0);
    assert.equal(r.actualCloudflareCost,null);
    assert.equal(r.oneGiBPhysicalFiles,0);
    assert.equal(r.productionAcceptance,'NO_GO');
    process.stdout.write('S5_598_REAL_PARSER_SMALL_SOURCE '+JSON.stringify({
      seed:r.seed,sha:r.largeSha256,bytes:r.receivedBytes,
      smallP95:r.smallLatency.p95,smallP99:r.smallLatency.p99,
      largeP95:r.largeLatency.p95,largeP99:r.largeLatency.p99,
      rssDelta:r.rssGrowthPeakBytes,cpuUserUs:r.cpuUserUs,cpuSystemUs:r.cpuSystemUs,
      externalNative:0,source:'localhost-real-598-parser-NO-HUB',
    })+'\n');
  });

test('#15 fixed trusted tenant shares cannot promote logical admissions to parser/native completions',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec(readFileSync('test/fixtures/s5-protected-share-local.sql','utf8'));
    const meter=new ProposedS5ProtectedTenantAdmission(db,{
      scope:'s5-real-parser-test-tenant-scope-01',globalRollingMinuteLimit:40,
      tenants:[{tenantId:'s5-real-noisy-tenant-A',weight:1},
        {tenantId:'s5-real-quiet-tenant-B',weight:1}],
    });
    const sha=createHash('sha256').update('logical-not-real-native').digest('hex');
    const when=new Date('2026-10-21T18:00:00.000Z');
    let noisy=0,quiet=0,denied=0;
    for(let n=0;n<40;n++){
      const x=meter.observe('s5-real-noisy-tenant-A','s5-noisy-operation-'+n,sha,when);
      assert.equal(x.authorizesToolExecution,false);
      if(x.status==='reserved')noisy++;else {
        assert.equal(x.status,'tenant-exhausted');denied++;
      }
    }
    for(let n=0;n<20;n++){
      const x=meter.observe('s5-real-quiet-tenant-B','s5-quiet-operation-'+n,sha,when);
      assert.equal(x.status,'reserved');assert.equal(x.authorizesToolExecution,false);quiet++;
    }
    assert.deepEqual({noisy,quiet,denied},{noisy:20,quiet:20,denied:20});
    const before=(db.prepare('SELECT COUNT(*) AS n FROM s5_fair_invocations')
      .get() as {n:number}).n;
    assert.equal(meter.observe('s5-real-quiet-tenant-B','s5-quiet-operation-0',sha,when).status,'duplicate');
    assert.equal(meter.observe('s5-client-forged-id','s5-forged-operation-00',sha,when).status,'unknown-tenant');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM s5_fair_invocations')
      .get() as {n:number}).n,before,'no duplicate charge');
    // No such admission is bound to #598 parser, actual OAuth or Cloudflare bills.
  }finally{db.close()}
});

test('#15 unbounded payload, memory and missing sample are rejected',async()=>{
  await assert.rejects(runS5RealParserSeeded({bodyBytes:1024*1024*1024}),/S5_UNBOUNDED_BODY/);
  await assert.rejects(runS5RealParserSeeded({bodyBytes:256*1024,rssGrowthLimitBytes:1024*1024*1024}),/S5_UNBOUNDED_RSS/);
});
