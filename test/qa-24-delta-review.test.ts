import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileIncremental,loadIncremental} from '../scripts/qa24-delta-review.js';

const fresh=()=>structuredClone(loadIncremental());
const one=(a:ReturnType<typeof loadIncremental>['delta'],pr:number)=>{
  const n=a.find(x=>x.pr===pr);assert.ok(n,`missing ${pr}`);return n;
};

test('QA24 incremental 160 + 15 = 173, but 175-census gap is NO-GO',()=>{
  const {graph,census,delta}=fresh(),r=reconcileIncremental(graph,census,delta);
  assert.equal(graph.nodes.length,160);
  assert.equal(delta.length,15);
  assert.equal(r.pinned_merged,173);
  assert.equal(census.ids.length,175);
  assert.deepEqual(r.missingCurrentIds,[774,775]);
  assert.deepEqual(r.noLongerOpenIds,[]);
  assert.ok(r.failures.includes('LIVE_CENSUS_DIFFERS_FROM_PINNED_DETAILS'));
  assert.equal(r.gate,'NO_GO');
  assert.equal(r.production_merge_authorized,false);
  assert.equal(r.current_safe_merge_candidates.length,0);
});

test('QA24 #772 Windows hosted red cannot become green due to other passing jobs',()=>{
  const {graph,census,delta}=fresh(),r=reconcileIncremental(graph,census,delta);
  assert.ok(r.delta_ci.some(n=>n.pr===772&&n.ci_run_id===39804484972&&n.ci_conclusion===null));
  assert.ok(r.missing_or_stale_sha_ci.every(n=>n.code==='UNVERIFIED_EXACT_HEAD_CI'));
  assert.equal(r.current_safe_merge_candidates.length,0);
});

test('QA24 exact SHA and primary run must match; historical success cannot be reused',()=>{
  const {graph,census,delta}=fresh();
  const n=one(delta,761);
  n.head_sha='f'.repeat(40);
  const r=reconcileIncremental(graph,census,delta);
  assert.ok(r.failures.includes('DELTA_CI_HEAD_MISMATCH'));
  assert.ok(r.failures.includes('DELTA_MERGE_BASE_MISSING_OR_STALE'));
  assert.equal(r.frozen_source_review_candidates.length,0);
});

test('QA24 no CI on #764 #765 #766 #768 fails closed, even if changed-file list complete',()=>{
  const {graph,census,delta}=fresh(),r=reconcileIncremental(graph,census,delta);
  for(const id of [764,765,766,768]) {
    const row=r.delta_ci.find(x=>x.pr===id);assert.ok(row);
    assert.equal(row.ci_run_id,null);
    assert.equal(row.ci_conclusion,null);
  }
});

test('QA24 merge-base tamper and missing changed-file lists are blocking',()=>{
  const {graph,census,delta}=fresh();
  one(delta,763).compare!.merge_base_sha='0'.repeat(40);
  one(delta,767).files_complete=false;
  const r=reconcileIncremental(graph,census,delta);
  assert.ok(r.failures.includes('DELTA_MERGE_BASE_MISSING_OR_STALE'));
  assert.ok(r.failures.includes('DELTA_OWNER_PATHS_MISSING'));
  assert.ok(r.invalid_merge_bases.some(x=>x.prs.includes(763)));
  assert.ok(r.changed_file_errors.some(x=>x.prs.includes(767)));
});

test('QA24 missing delta PR, duplicate PR, wrong parent refs all reject review',()=>{
  const {graph,census,delta}=fresh();
  delta.splice(delta.findIndex(x=>x.pr===773),1);
  delta.push(structuredClone(one(delta,772)));
  one(delta,760).base_ref='missing-owner-ref';
  const r=reconcileIncremental(graph,census,delta);
  assert.ok(r.failures.includes('DELTA_RANGE_OR_DUPLICATES'));
  assert.ok(r.unresolved_parent_refs.some(x=>x.prs.includes(760)));
  assert.equal(r.current_safe_merge_candidates.length,0);
});

test('QA24 changed current open set blocks safe list even with passed source tests',()=>{
  const {graph,census,delta}=fresh();
  census.ids.push(776);
  census.segments.at(-1)!.ids.push(776);
  const r=reconcileIncremental(graph,census,delta);
  assert.deepEqual(r.missingCurrentIds,[774,775,776]);
  assert.equal(r.current_safe_merge_candidates.length,0);
});

test('QA24 baseline and new ancestry cannot erase known stale #609/#622',()=>{
  const {graph,census,delta}=fresh(),r=reconcileIncremental(graph,census,delta);
  assert.ok(r.stale_parent.includes(609));
  assert.ok(r.stale_parent.includes(622));
  assert.ok(r.red_or_stale_ancestors.length>0);
});

test('QA24 frozen #648/#657 are only conflict-free conditional review, never merge approval',()=>{
  const {graph,census,delta}=fresh(),r=reconcileIncremental(graph,census,delta);
  const ids=r.frozen_source_review_candidates.map(x=>x.pr);
  assert.deepEqual(ids,[657,648]);
  for(const row of r.frozen_source_review_candidates)
    assert.equal(row.rank,'CONDITIONAL_SOURCE_REVIEW_ONLY');
  assert.deepEqual(r.current_safe_merge_candidates,[]);
  assert.equal(r.live_set_freshly_revalidated,false);
});

test('QA24 source collision with independent reviewer removes its conditional candidate',()=>{
  const {graph,census,delta}=fresh();
  one(delta,773).files.push(graph.nodes.find(n=>n.pr===648)!.files[0]!);
  const r=reconcileIncremental(graph,census,delta);
  assert.ok(!r.frozen_source_review_candidates.some(x=>x.pr===648));
  assert.equal(r.current_safe_merge_candidates.length,0);
});
