import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ProposedAllIngressTransportMeter} from '../src/mcp/all-ingress-transport-meter-proposal.js';
import {runS5LoopbackLoad} from '../scripts/bench-s5-loopback-ws-capacity.js';

for(const clients of [16,32,64,100,256]){
  test('S5 loopback socket capacity: '+clients+' synthetic clients', {timeout:150000},async()=>{
    const r=await runS5LoopbackLoad({clients,mode:'isolated'});
    assert.equal(r.sockets.connected,clients);
    assert.equal(r.sockets.peak,clients);
    assert.equal(r.rpc.attempted,clients*2+Math.min(clients,8));
    assert.equal(r.rpc.reserved,clients*2);
    assert.equal(r.rpc.duplicate,Math.min(clients,8));
    assert.equal(r.rpc.rateLimited,0);
    assert.equal(r.rpc.backpressure,0);
    assert.equal(r.rpc.other,0);
    assert.equal(r.ledger.rows,clients*2);
    assert.equal(r.ledger.dailyUsed,r.rpc.reserved);
    assert.equal(r.ledger.toolExecutions,0);
    assert.equal(r.fairness.jainIndex,1);
    assert.ok(r.rpc.peakInFlight<=8);
    assert.ok(r.rpc.peakQueue<=256);
    assert.ok(r.latencyMs.p99>=r.latencyMs.p95);
    assert.ok(r.memoryBytes.rssPeak>=r.memoryBytes.rssStart);
  });
}
test('S5 isolation vs one shared quota: other tenant must retain allowance',{timeout:150000},async()=>{
  const isolated=await runS5LoopbackLoad({clients:64,callsPerClient:2,mode:'isolated',dailyLimit:100});
  assert.equal(isolated.rpc.reserved,128);
  assert.equal(isolated.ledger.dailyUsed,128);
  const shared=await runS5LoopbackLoad({clients:64,callsPerClient:2,mode:'shared',dailyLimit:100});
  assert.equal(shared.rpc.reserved,100);
  assert.equal(shared.ledger.dailyUsed,100);
  assert.equal(shared.rpc.other,28); // daily-exhausted: not a network failure
});
test('S5 bounded queue overload reports backpressure and never overspends',{timeout:150000},async()=>{
  const r=await runS5LoopbackLoad({clients:64,queueCap:1,maxInFlight:1});
  assert.ok(r.rpc.backpressure>0);
  assert.equal(r.ledger.rows,r.rpc.reserved);
  assert.equal(r.ledger.dailyUsed,r.rpc.reserved);
  assert.equal(r.ledger.toolExecutions,0);
});
test('S5 existing SQLite rolling 600/min meter: boundary, replay ingress, rollover and shared scope',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'nexowire-s5-minute-'));
  const db=new DatabaseSync(path.join(dir,'minute.sqlite'));
  try{
    // Non-durability unit test: use in-memory journal to isolate rolling-window logic.
    db.exec('PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF;');
    db.exec(readFileSync(path.resolve('test/fixtures/scale-v2-all-ingress-transport-staging.sql'),'utf8'));
    const meter=new ProposedAllIngressTransportMeter(db,600);
    const at=new Date('2026-10-18T12:00:00.000Z');
    for(let i=0;i<600;i++)assert.equal(meter.observe('shared-synthetic-tunnel',at).allowed,true);
    for(let i=0;i<12;i++){
      const r=meter.observe('shared-synthetic-tunnel',at);
      assert.equal(r.allowed,false);
      assert.equal(r.retryAfterMs,60000);
      assert.equal(r.admittedTotal,600);
      assert.equal(r.rejectedTotal,i+1);
    }
    assert.equal(meter.observe('separate-synthetic-scope',at).allowed,true);
    assert.equal(meter.observe('shared-synthetic-tunnel',new Date(at.getTime()+60001)).allowed,true);
    assert.throws(()=>meter.observe('shared-synthetic-tunnel',at),/clock moved backward/);
  }finally{db.close();rmSync(dir,{recursive:true,force:true})}
});
test('S5 defaults reject unsafe workload expansion and network target options',async()=>{
  for(const options of [
    {clients:257},{clients:0},{clients:16,callsPerClient:5},
    {clients:16,maxInFlight:17},{clients:16,minuteLimit:601},
    {clients:16,queueCap:999},{clients:16,dailyLimit:850001},
    {clients:16,mode:'production' as 'isolated'},
  ])await assert.rejects(runS5LoopbackLoad(options));
});
