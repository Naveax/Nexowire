import test from 'node:test';
import assert from 'node:assert/strict';
import {load791803,reconcile791803} from '../scripts/qa24-delta791-review.js';

const fresh=()=>structuredClone(load791803());
const one=(a:ReturnType<typeof load791803>['new13'],id:number)=>{
 const x=a.find(n=>n.pr===id);assert.ok(x);return x;
};
const audit=()=>{const x=fresh();return reconcile791803(
 x.graph,x.delta,x.newDelta,x.ten,x.new13,x.census,x.changed,x.owner);};

test('QA24 160+15+6+10+13=202, but 205 OPEN is NOT complete',()=>{
 const r=audit();
 assert.equal(r.known_nodes,202);
 assert.equal(r.observed_open_ids,205);
 assert.deepEqual(r.missing_ids,[804,805,806]);
 assert.equal(r.dependency_edges,170);
 assert.equal(r.independent_owner_overlap_pairs,281);
 assert.equal(r.new_overlap_pairs.length,32);
 assert.equal(r.gate,'NO_GO');
 assert.equal(r.full_live_head_ci_reverified,false);
 assert.deepEqual(r.current_safe_merge_candidates,[]);
 assert.ok(r.failures.includes('LIVE_ID_SET_NOT_COVERED'));
});

test('QA24 moved #708 diverged merge-base and red #726/718 cannot become green',()=>{
 const r=audit();
 assert.equal(r.owner708?.ci.run_id,39824007092);
 assert.equal(r.owner708?.ci.conclusion,'failure');
 assert.equal(r.owner708?.compare?.status,'diverged');
 assert.notEqual(r.owner708?.compare?.merge_base_sha,r.owner708?.base_sha);
 assert.ok(r.failures.includes('708_DIVERGED_MERGE_BASE'));
 assert.equal(r.owner726?.ci.run_id,39823764746);
 assert.equal(r.owner726?.ci.conclusion,'failure');
 assert.ok(r.failures.includes('726_EXACT_RED_CI'));
 assert.equal(r.owner718_current_witness.conclusion,'failure');
 assert.ok(r.failures.includes('STORED_718_HEAD_STALE'));
});

test('QA24 793 794 795 797 801 803 green, 800 and 802 red, 791 792 799 red',()=>{
 const r=audit();
 for(const id of [793,794,795,797,801,803])
   assert.equal(r.delta_primary_ci.find(x=>x.pr===id)?.conclusion,'success',String(id));
 for(const id of [791,792,799,800,802])
   assert.equal(r.delta_primary_ci.find(x=>x.pr===id)?.conclusion,'failure',String(id));
 assert.equal(r.delta_primary_ci.length,13);
 assert.equal(r.production_merge_authorized,false);
});

test('QA24 all 32 new unrelated same-file collisions involve 801/802 CI workflow',()=>{
 const r=audit();
 assert.equal(r.new_overlap_pairs.length,32);
 assert.ok(r.new_overlap_pairs.every(x=>[801,802].includes(x.a)||[801,802].includes(x.b)));
 assert.ok(r.new_overlap_pairs.every(x=>x.files.includes('.github/workflows/ci.yml')));
});

test('QA24 green 797 inherits red 777 through 785; source green cannot override ancestor',()=>{
 const r=audit();
 const x=r.source_dependency_review_order.find(x=>x.pr===797);assert.ok(x);
 assert.ok(x.parent_chain_from_nearest.includes(785));
 assert.ok(x.parent_chain_from_nearest.includes(777));
 assert.ok(x.red_or_unknown_parents.includes(777));
 assert.ok(x.blockers.includes('RED_OR_UNKNOWN_ANCESTOR'));
 assert.equal(x.label,'BLOCKED_OR_OWNER_REVIEW');
 assert.ok(r.stale_parents.some(x=>x.prs.includes(609)));
 assert.ok(r.stale_parents.some(x=>x.prs.includes(622)));
});

test('QA24 #803 source-green does not imply production merge permission',()=>{
 const r=audit();
 const n=r.source_dependency_review_order.find(x=>x.pr===803);
 assert.ok(n);assert.equal(n.exact_ci, 'success');
 assert.equal(r.production_merge_authorized,false);
 assert.deepEqual(r.current_safe_merge_candidates,[]);
 assert.deepEqual(r.source_review_candidates_only,[781,657,648]);
});

test('QA24 invalid SHA/CI, bad base and unknown changed files fail closed',()=>{
 const x=fresh();
 one(x.new13,793).head_sha='f'.repeat(40);
 one(x.new13,794).base_ref='';
 one(x.new13,795).compare!.merge_base_sha='e'.repeat(40);
 one(x.new13,796).files_complete=false;
 const r=reconcile791803(x.graph,x.delta,x.newDelta,x.ten,x.new13,x.census,
   x.changed,x.owner);
 for(const f of ['MISSING_SHA_OR_BRANCH','EXACT_CI_HEAD_INVALID','COMPARE_UNVERIFIED',
   'CHANGED_FILE_SCOPE_UNKNOWN'])assert.ok(r.failures.includes(f),f);
 assert.deepEqual(r.current_safe_merge_candidates,[]);
});

test('QA24 duplicate target, changed open census and compromised owner receipt block',()=>{
 const x=fresh();
 x.new13.pop();x.new13.push(structuredClone(one(x.new13,802)));
 x.census.ids.push(807);x.census.segments.at(-1)!.ids.push(807);
 x.owner.critical_owner.conclusion='success';
 const r=reconcile791803(x.graph,x.delta,x.newDelta,x.ten,x.new13,x.census,
   x.changed,x.owner);
 assert.ok(r.failures.includes('DELTA_791_803_MISSING_OR_DUPLICATE'));
 assert.ok(r.failures.includes('LIVE_ID_SET_NOT_COVERED'));
 assert.ok(r.failures.includes('STORED_718_HEAD_STALE'));
 assert.equal(r.production_merge_authorized,false);
});
