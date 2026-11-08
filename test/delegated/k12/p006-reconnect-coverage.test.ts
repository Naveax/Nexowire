/** #487 / #539: bounded localhost QA, not provider or physical acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {runS5LoopbackLoad} from '../../../scripts/bench-s5-loopback-ws-capacity.js';
import {
  runS5ReconnectStorm,type S5StormTeardown,
} from '../../../scripts/bench-s5-loopback-reconnect-storm.js';
import {summarizeS5ScenarioResults} from '../../../scripts/report-s5-measured-scenarios.js';

const noResources:S5StormTeardown={
  openClients:0,openServerSockets:0,queued:0,processing:0,
};

test('T-602 three reconnect rounds replay IDs without duplicate admission or native completion',
  {timeout:10000},async()=>{
    const measured=await runS5ReconnectStorm({socketsPerRound:3,rounds:3,
      queueLimit:8,processingLimit:3});
    assert.equal(measured.requests,9);
    assert.equal(measured.uniqueReservations,3);
    assert.equal(measured.duplicates,6);
    assert.equal(measured.backpressure,0);
    assert.equal(measured.opened,9);
    assert.equal(measured.closed,9);
    assert.equal(measured.reportedNativeCompleted,0);
    assert.equal(measured.verifiedNativeCompleted,0);

    const controller=new AbortController();
    const teardown:S5StormTeardown[]=[];
    const rounds:number[]=[];
    const cancelled=runS5ReconnectStorm({socketsPerRound:3,rounds:3,
      queueLimit:8,processingLimit:3,signal:controller.signal,
      onConnectedBatch:round=>{rounds.push(round);if(round===2)controller.abort()},
      onTeardown:state=>teardown.push(state)});
    await assert.rejects(cancelled,/S5 storm aborted/);
    assert.deepEqual(rounds,[0,1,2]);
    assert.deepEqual(teardown,[noResources]);
  });

test('T-603 16/32/64 localhost clients never produce hosted/provider capacity',
  {timeout:30000},async()=>{
    const results=[];
    for(const clients of [16,32,64]){
      const observed=await runS5LoopbackLoad({clients,callsPerClient:1,mode:'isolated'});
      assert.equal(observed.sockets.peak,clients);
      assert.equal(observed.sockets.closed,clients);
      assert.equal(observed.ledger.toolExecutions,0);
      results.push(observed);
    }
    const summary=summarizeS5ScenarioResults(results);
    assert.deepEqual(summary.scenarios.map(x=>x.clients),[16,32,64]);
    assert.equal(summary.measurementClassification,'LOCAL_SYNTHETIC_ONLY');
    assert.equal(summary.capacityEstimate,null);
    assert.equal(summary.providerCapacityProven,false);
  });

test('T-604 abort cleanup lets an isolated Node process exit without live timers or sockets',
  {timeout:10000},()=>{
    // A successful onTeardown snapshot alone cannot detect timers or sockets
    // that keep the Node event loop alive. Observe real subprocess termination.
    const script=`import {runS5ReconnectStorm} from './scripts/bench-s5-loopback-reconnect-storm.ts';
      const controller=new AbortController();
      try {
        await runS5ReconnectStorm({socketsPerRound:3,rounds:3,
          queueLimit:3,processingLimit:1,signal:controller.signal,
          onConnectedBatch:round=>{if(round===2)controller.abort()}});
        throw new Error('cancel unexpectedly succeeded');
      } catch(e) {
        if(!String(e).includes('S5 storm aborted'))throw e;
      }
      process.stdout.write('CANCELLED_AND_CLOSED');`;
    const child=spawnSync(process.execPath,
      ['--import','tsx','--input-type=module','--eval',script],
      {cwd:process.cwd(),encoding:'utf8',timeout:4000});
    assert.equal(child.error?.message,undefined,
      'subprocess kept a timer/socket open after fixture teardown');
    assert.equal(child.status,0,child.stderr);
    assert.equal(child.stdout,'CANCELLED_AND_CLOSED');
  });

test('T-606 local results have no provider/24h/Windows acceptance evidence',
  {timeout:10000},async()=>{
    const local=await runS5LoopbackLoad({clients:1,callsPerClient:1});
    const storm=await runS5ReconnectStorm({socketsPerRound:1,rounds:1,
      queueLimit:1,processingLimit:1});
    assert.equal(local.kind,'SYNTHETIC_LOOPBACK_WS_OWNER_SQLITE');
    assert.equal(storm.kind,'SYNTHETIC_LOOPBACK_WS_NO_REAL_NATIVE_TOOL');
    assert.ok(local.constraints.some(x=>x.includes('not wss://')));
    assert.ok(local.constraints.some(x=>x.includes('24h soak NOT RUN')));
    assert.equal(storm.verifiedNativeCompleted,0);
    const summary=summarizeS5ScenarioResults([local]);
    assert.equal(summary.providerCapacityProven,false);
    assert.equal(summary.capacityEstimate,null);
    for(const serialized of [JSON.stringify(local),JSON.stringify(storm)]){
      assert.doesNotMatch(serialized,/"(?:providerVerified|windowsPhysicalAccepted|soak24hAccepted|productionAccepted)":true/);
    }
  });
