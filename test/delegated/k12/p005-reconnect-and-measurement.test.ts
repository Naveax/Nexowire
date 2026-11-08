/** #539/R06/R12 and #487: bounded local fixture evidence, never live acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {runS5LoopbackLoad} from '../../../scripts/bench-s5-loopback-ws-capacity.js';
import {
  runS5ReconnectStorm,type S5StormTeardown,
} from '../../../scripts/bench-s5-loopback-reconnect-storm.js';
import {summarizeS5ScenarioResults} from '../../../scripts/report-s5-measured-scenarios.js';

const empty:S5StormTeardown={openClients:0,openServerSockets:0,queued:0,processing:0};

test('T-462 minimum second-round abort releases the sole socket and permits restart',
  {timeout:10000},async()=>{
    const controller=new AbortController();
    const phases:number[]=[];
    const after:S5StormTeardown[]=[];
    const cancelled=runS5ReconnectStorm({socketsPerRound:1,rounds:2,
      queueLimit:1,processingLimit:1,signal:controller.signal,
      onConnectedBatch:round=>{phases.push(round);if(round===1)controller.abort()},
      onTeardown:state=>after.push(state)});
    await assert.rejects(cancelled,/S5 storm aborted/);
    assert.deepEqual(phases,[0,1]);
    assert.deepEqual(after,[empty]);
    // A second invocation in the same Node process rules out stale fixture
    // state being interpreted as successful reconnection after cancellation.
    const retry=await runS5ReconnectStorm({socketsPerRound:1,rounds:2,
      queueLimit:1,processingLimit:1});
    assert.equal(retry.opened,2);
    assert.equal(retry.closed,2);
    assert.equal(retry.uniqueReservations,1);
    assert.equal(retry.duplicates,1);
  });

test('T-463 both local benchmarks count samples but reject tail SLO certification',
  {timeout:10000},async()=>{
    const capacity=await runS5LoopbackLoad({clients:2,callsPerClient:2});
    const storm=await runS5ReconnectStorm({socketsPerRound:2,rounds:2,
      queueLimit:2,processingLimit:1});
    assert.equal(capacity.latencyEvidence?.samples,capacity.rpc.attempted);
    assert.equal(storm.latencyEvidence.samples,storm.requests);
    for(const evidence of [capacity.latencyEvidence,storm.latencyEvidence]){
      assert.ok(evidence);
      assert.ok(evidence.samples>1);
      assert.equal(evidence.classification,'LOCAL_SYNTHETIC_DESCRIPTIVE_ONLY');
      assert.equal(evidence.tailSloAccepted,false);
    }
    const summary=summarizeS5ScenarioResults([capacity]);
    assert.equal(summary.capacityEstimate,null);
    assert.equal(summary.providerCapacityProven,false);
  });

test('T-464 cancelled fixture never resolves a successful counter report',
  {timeout:10000},async()=>{
    const controller=new AbortController();
    const teardown:S5StormTeardown[]=[];
    let completed=false;
    const attempt=runS5ReconnectStorm({socketsPerRound:2,rounds:3,
      queueLimit:2,processingLimit:1,signal:controller.signal,
      onConnectedBatch:round=>{if(round===1)controller.abort()},
      onTeardown:state=>teardown.push(state)}).then(()=>{completed=true});
    await assert.rejects(attempt,/S5 storm aborted/);
    assert.equal(completed,false);
    assert.deepEqual(teardown,[empty]);
  });

test('T-466 successful short reconnect is not evidence of long-lived provider capacity',
  {timeout:10000},async()=>{
    const measured=await runS5LoopbackLoad({clients:1,callsPerClient:1});
    const reconnect=await runS5ReconnectStorm({socketsPerRound:1,rounds:3,
      queueLimit:1,processingLimit:1});
    assert.equal(measured.sockets.connected,measured.sockets.closed);
    assert.equal(reconnect.opened,reconnect.closed);
    assert.equal(reconnect.reportedNativeCompleted,0);
    assert.equal(reconnect.verifiedNativeCompleted,0);
    assert.equal(measured.ledger.toolExecutions,0);
    const summary=summarizeS5ScenarioResults([measured]);
    assert.equal(summary.capacityEstimate,null);
    assert.equal(summary.providerCapacityProven,false);
    assert.ok(measured.constraints.some(x=>x.includes('24h soak NOT RUN')));
    assert.ok(measured.constraints.some(x=>x.includes('not wss://')));
    for(const result of [measured,reconnect]){
      const serial=JSON.stringify(result);
      assert.doesNotMatch(serial,/"(?:providerCapacity|uptime24h|productionAccepted)":true/);
    }
  });
