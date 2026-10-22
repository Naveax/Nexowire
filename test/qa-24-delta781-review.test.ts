import test from 'node:test';
import assert from 'node:assert/strict';
import {load781790,reconcile781790} from '../scripts/qa24-delta781-review.js';

const fresh=()=>structuredClone(load781790());
const get=(a:ReturnType<typeof load781790>['ten'],pr:number)=>{
  const n=a.find(x=>x.pr===pr);assert.ok(n,`Missing fixture #${pr}`);return n;
};

test('QA24 frozen 160+15+6+10 is 189, but 198-current census is incomplete',()=>{
  const {graph,delta,newDelta,ten,census,owner}=fresh();
  const r=reconcile781790(graph,delta,newDelta,ten,census,owner);
  assert.equal(graph.nodes.length,160);
  assert.equal(delta.length,15);
  assert.equal(newDelta.length,6);
  assert.equal(ten.length,10);
  assert.equal(r.known_nodes,189);
  assert.equal(r.recorded_open_count,198);
  assert.deepEqual(r.missingFromDetails,[791,792,793,794,795,796,797,798,799]);
  assert.equal(r.dependency_edges,158);
  assert.equal(r.total_owner_collision_pairs,249);
  assert.equal(r.new_owner_collision_pairs.length,16);
  assert.equal(r.gate,'NO_GO');
  assert.equal(r.production_merge_authorized,false);
  assert.deepEqual(r.current_safe_merge_candidates,[]);
  assert.ok(r.failures.includes('LIVE_OPEN_SET_NOT_FULLY_COVERED'));
});

test('QA24 718 exact Windows failure at MOVED SHA never inherits historical green',()=>{
  const {graph,delta,newDelta,ten,census,owner}=fresh();
  const r=reconcile781790(graph,delta,newDelta,ten,census,owner);
  assert.equal(r.owner718.current_exact_head,'81931c5f3d9a0995b621bd3c678ab0854876e26d');
  assert.equal(r.owner718.exact_run,39817410885);
  assert.equal(r.owner718.ci_conclusion,'failure');
  assert.equal(r.owner718.historical_head_moved,true);
  assert.ok(r.failures.includes('HISTORICAL_718_HEAD_DRIFT'));
});

test('QA24 exact CI statuses #786/#790 red, #782/#783 running, #789 green',()=>{
  const {graph,delta,newDelta,ten,census,owner}=fresh();
  const r=reconcile781790(graph,delta,newDelta,ten,census,owner);
  for(const pr of [786,790])assert.equal(r.exact_primary_ci.find(x=>x.pr===pr)?.conclusion,'failure');
  for(const pr of [782,783]){
    const c=r.exact_primary_ci.find(x=>x.pr===pr);assert.ok(c);
    assert.equal(c.status,'in_progress');
    assert.equal(c.conclusion,null);
  }
  assert.equal(r.exact_primary_ci.find(x=>x.pr===789)?.conclusion,'success');
  assert.equal(r.production_merge_authorized,false);
});

test('QA24 #785 green child of red #777 and #790 child of red #779 blocked',()=>{
  const {graph,delta,newDelta,ten,census,owner}=fresh();
  const r=reconcile781790(graph,delta,newDelta,ten,census,owner);
  assert.ok(r.red_or_stale_ancestor.some(x=>x.prs.includes(785)));
  assert.ok(r.red_or_stale_ancestor.some(x=>x.prs.includes(790)));
  assert.ok(r.stale_parent.some(x=>x.prs.includes(609)));
  assert.ok(r.stale_parent.some(x=>x.prs.includes(622)));
  assert.ok(r.unresolved_parent.some(x=>x.prs.includes(776)));
});

test('QA24 #790 independent workflow collisions never suppressed by source-success',()=>{
  const {graph,delta,newDelta,ten,census,owner}=fresh();
  const r=reconcile781790(graph,delta,newDelta,ten,census,owner);
  assert.equal(r.new_owner_collision_pairs.length,16);
  assert.ok(r.new_owner_collision_pairs.every(x=>[x.a,x.b].includes(790)));
  assert.ok(r.new_owner_collision_pairs.every(x=>x.files.includes('.github/workflows/ci.yml')));
});

test('QA24 only conditional source review queue; 780 remains P1 ISSUE',()=>{
  const {graph,delta,newDelta,ten,census,owner}=fresh();
  const r=reconcile781790(graph,delta,newDelta,ten,census,owner);
  assert.deepEqual(r.frozen_conditional_source_review.map(x=>x.pr),[781,657,648]);
  assert.equal(r.issue_780.is_mergeable_pr,false);
  assert.equal(r.issue_780.type,'P1_PRODUCT_EPIC');
  assert.equal(r.live_full_head_revalidation,false);
  assert.equal(r.source_snapshot_stale,true);
  assert.deepEqual(r.current_safe_merge_candidates,[]);
});

test('QA24 missing ref, SHA/CI re-use, bad compare and incomplete paths all fail closed',()=>{
  const {graph,delta,newDelta,ten,census,owner}=fresh();
  get(ten,782).base_ref='';
  get(ten,783).head_sha='f'.repeat(40);
  get(ten,788).compare!.merge_base_sha='e'.repeat(40);
  get(ten,789).files_complete=false;
  const r=reconcile781790(graph,delta,newDelta,ten,census,owner);
  for(const code of ['MISSING_REF_OR_BAD_SHA','EXACT_HEAD_CI_REF_MISMATCH',
    'INVALID_SHA_BOUND_MERGE_BASE','OWNER_FILES_INCOMPLETE'])
    assert.ok(r.failures.includes(code),code);
  assert.deepEqual(r.current_safe_merge_candidates,[]);
});

test('QA24 new 800th PR / duplicate open partitions / missing delta are hard failures',()=>{
  const {graph,delta,newDelta,ten,census,owner}=fresh();
  census.ids.push(800);census.segments.at(-1)!.ids.push(800);
  ten.pop();ten.push(structuredClone(get(ten,789)));
  const r=reconcile781790(graph,delta,newDelta,ten,census,owner);
  assert.ok(r.failures.includes('LIVE_OPEN_SET_NOT_FULLY_COVERED'));
  assert.ok(r.failures.includes('DELTA_781_790_DUPLICATE_OR_INCOMPLETE'));
  assert.deepEqual(r.current_safe_merge_candidates,[]);
  const dup=fresh();dup.census.segments[1]!.ids.push(dup.census.segments[0]!.ids[0]!);
  assert.ok(reconcile781790(dup.graph,dup.delta,dup.newDelta,dup.ten,dup.census,dup.owner)
    .failures.includes('PAGINATION_PARTITION_GAP_OR_DUPLICATE'));
});

test('QA24 forged owner 718 SUCCESS witness cannot turn live red into green',()=>{
  const {graph,delta,newDelta,ten,census,owner}=fresh();
  owner.critical_owner.conclusion='success';
  const r=reconcile781790(graph,delta,newDelta,ten,census,owner);
  assert.ok(r.failures.includes('OWNER_718_WITNESS_MISSING_OR_INVALID'));
  assert.equal(r.production_merge_authorized,false);
});
