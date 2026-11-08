/** Issue #487 and #539/R06/R12: source-only loopback evidence, not deployment acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {runS5LoopbackLoad} from '../../../scripts/bench-s5-loopback-ws-capacity.js';
import {runS5ReconnectStorm,type S5StormTeardown} from
  '../../../scripts/bench-s5-loopback-reconnect-storm.js';

const emptyTeardown:S5StormTeardown={openClients:0,openServerSockets:0,queued:0,processing:0};

test('T-322 abort on a later reconnect round closes sockets and drops queued work',
  {timeout:10000},async()=>{
    const controller=new AbortController();
    const teardown:S5StormTeardown[]=[];
    const phases:Array<[number,number]>=[];
    const running=runS5ReconnectStorm({socketsPerRound:12,rounds:3,
      queueLimit:4,processingLimit:1,signal:controller.signal,
      onConnectedBatch:(round,start)=>{
        phases.push([round,start]);
        if(round===1)controller.abort();
      },
      onTeardown:state=>teardown.push(state),
    });
    await assert.rejects(running,/S5 storm aborted/);
    assert.deepEqual(phases,[[0,0],[1,0]]);
    assert.deepEqual(teardown,[emptyTeardown]);
  });

test('T-323 singleton local percentile is descriptive, never accepted as p95/p99 SLO',
  {timeout:10000},async()=>{
    const storm=await runS5ReconnectStorm({socketsPerRound:1,rounds:1,
      queueLimit:1,processingLimit:1});
    assert.equal(storm.latencyEvidence.samples,1);
    assert.equal(storm.latencyEvidence.classification,'LOCAL_SYNTHETIC_DESCRIPTIVE_ONLY');
    assert.equal(storm.latencyEvidence.tailSloAccepted,false);
    assert.equal(storm.latencyMs.p50,storm.latencyMs.p95);
    assert.equal(storm.latencyMs.p95,storm.latencyMs.p99);
    assert.equal(storm.verifiedNativeCompleted,0);
  });

test('T-324 timeout cancellation never publishes a completed sample',
  {timeout:10000},async()=>{
    const controller=new AbortController();
    const teardown:S5StormTeardown[]=[];
    const work=runS5ReconnectStorm({socketsPerRound:128,rounds:3,
      queueLimit:4,processingLimit:1,
      signal:controller.signal,onConnectedBatch:()=>controller.abort(),
      onTeardown:state=>teardown.push(state)});
    await assert.rejects(work,/S5 storm aborted/);
    assert.deepEqual(teardown,[emptyTeardown]);
  });

test('T-325 local results serialize as JSON; CSV reporter is outside K12 owner paths',
  {timeout:10000},async()=>{
    const r=await runS5LoopbackLoad({clients:1,callsPerClient:1});
    const encoded=JSON.stringify(r);
    assert.deepEqual(JSON.parse(encoded),r);
    assert.ok(r.latencyEvidence);
    assert.equal(r.latencyEvidence.samples,r.rpc.attempted);
    assert.equal(r.latencyEvidence.tailSloAccepted,false);
    const reportSource=readFileSync(path.resolve('scripts/report-s5-measured-scenarios.ts'),'utf8');
    assert.match(reportSource,/JSON\.stringify\(report/);
    assert.doesNotMatch(reportSource,/\.csv\b|text\/csv|csv-stringify/i);
  });

test('T-326 peak local sockets never imply authenticated production capacity',
  {timeout:30000},async()=>{
    const r=await runS5LoopbackLoad({clients:64,callsPerClient:1});
    assert.equal(r.sockets.connected,64);
    assert.equal(r.sockets.peak,64);
    assert.equal(r.sockets.closed,64);
    assert.equal(r.ledger.toolExecutions,0);
    assert.ok(r.latencyEvidence);
    assert.equal(r.latencyEvidence.samples,r.rpc.attempted);
    assert.equal(r.latencyEvidence.tailSloAccepted,false);
    assert.equal(r.latencyEvidence.classification,'LOCAL_SYNTHETIC_DESCRIPTIVE_ONLY');
    assert.ok(r.constraints.some(s=>s.includes('not wss://')));
    assert.ok(r.constraints.some(s=>s.includes('24h soak NOT RUN')));
  });
