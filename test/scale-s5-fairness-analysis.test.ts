import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {ProposedAllIngressTransportMeter} from '../src/mcp/all-ingress-transport-meter-proposal.js';
import {analyzeS5Fairness} from '../src/ops/scale-s5-fairness-analysis.js';

test('S5 normalized Jain detects starvation hidden by total global request count',()=>{
  const r=analyzeS5Fairness([
    {attempted:600,reserved:600,transportDenied:0,quotaDenied:0},
    {attempted:20,reserved:0,transportDenied:20,quotaDenied:0},
  ]);
  assert.equal(r.reserved,600);
  assert.equal(r.starvedTenants,1);
  assert.equal(r.demandNormalizedJain,0.5);
  assert.equal(r.rawSuccessCountJain,0.5);
  assert.equal(r.minAdmissionRatio,0);
});
test('S5 rate meter can starve a quiet tenant when another arrives first',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec(readFileSync(path.resolve('test/fixtures/scale-v2-all-ingress-transport-staging.sql'),'utf8'));
    const meter=new ProposedAllIngressTransportMeter(db,600);
    const at=new Date('2026-10-18T12:00:00Z');
    const results=[] as Array<{attempted:number;reserved:number;transportDenied:number;quotaDenied:number}>;
    for(const count of [600,20]){
      let reserved=0,transportDenied=0;
      for(let i=0;i<count;i++){
        if(meter.observe('one-verified-shared-tunnel',at).allowed)reserved++;
        else transportDenied++;
      }
      results.push({attempted:count,reserved,transportDenied,quotaDenied:0});
    }
    const summary=analyzeS5Fairness(results);
    assert.equal(summary.starvedTenants,1);
    assert.equal(summary.demandNormalizedJain,0.5);
    assert.equal(summary.attempted,620);
  }finally{db.close()}
});
test('S5 Jain normalization does not penalize legitimate unequal demand',()=>{
  const r=analyzeS5Fairness([
    {attempted:600,reserved:600,transportDenied:0,quotaDenied:0},
    {attempted:20,reserved:20,transportDenied:0,quotaDenied:0},
  ]);
  assert.ok(r.rawSuccessCountJain<0.6);
  assert.equal(r.demandNormalizedJain,1);
  assert.equal(r.starvedTenants,0);
});
test('S5 fairness rejects mismatch, negative counters and empty samples',()=>{
  for(const input of [
    [],
    [{attempted:10,reserved:11,transportDenied:0,quotaDenied:0}],
    [{attempted:10,reserved:2,transportDenied:5,quotaDenied:0}],
    [{attempted:1,reserved:-1,transportDenied:2,quotaDenied:0}],
  ])assert.throws(()=>analyzeS5Fairness(input));
});
