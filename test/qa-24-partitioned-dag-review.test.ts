import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluatePartitionedDag,loadPinnedGraph} from '../scripts/qa24-partitioned-dag-review.js';

const snapshot=()=>structuredClone(loadPinnedGraph());
const issue=(result:ReturnType<typeof evaluatePartitionedDag>,code:string,pr:number)=>
  result.issues.some(x=>x.code===code&&x.prs.includes(pr));
const get=(graph:ReturnType<typeof loadPinnedGraph>['graph'],pr:number)=>{
  const n=graph.nodes.find(x=>x.pr===pr);assert.ok(n);return n;
};

test('QA24 160 disjoint date-partitioned PRs, full file+compare evidence, no automatic merge',()=>{
  const {graph,census}=snapshot(),r=evaluatePartitionedDag(graph,census);
  assert.equal(graph.nodes.length,160);
  assert.equal(census.ids.length,160);
  assert.equal(census.segments.length,4);
  assert.ok(census.segments.every(s=>s.ids.length<100));
  assert.equal(new Set(graph.nodes.map(x=>x.pr)).size,160);
  assert.ok(graph.nodes.every(x=>x.files_complete&&x.files.length>0&&x.compare?.status));
  assert.equal(r.edges,132);
  assert.equal(r.gate,'NO_GO');
  assert.equal(r.production_merge_authorized,false);
  assert.equal(r.live_freshness_verified,false);
  assert.ok(!r.issues.some(x=>x.code==='STALE_OPEN_PR_CENSUS'));
});

test('QA24 no fake green for missing CI in #749 #753 #757 or unfinished #759',()=>{
  const {graph,census}=snapshot(),r=evaluatePartitionedDag(graph,census);
  for(const id of [749,753,757,759]){
    assert.ok(r.ci_unknown.includes(id),String(id));
    assert.ok(issue(r,'UNVERIFIED_EXACT_HEAD_CI',id)||issue(r,'NON_GREEN_MAIN_CI',id));
    assert.ok(!r.review_candidates.some(c=>c.pr===id));
  }
});

test('QA24 stale parent #609/#622 and red ancestor inhibit review',()=>{
  const {graph,census}=snapshot(),r=evaluatePartitionedDag(graph,census);
  for(const pr of [609,622])assert.ok(issue(r,'STALE_PARENT_HEAD',pr));
  assert.ok(issue(r,'RED_OR_STALE_ANCESTOR',633));
  assert.ok(issue(r,'RED_OR_STALE_ANCESTOR',669));
});

test('QA24 old SHA green cannot apply to new HEAD even with old CI marked success',()=>{
  const {graph,census}=snapshot();
  get(graph,648).head_sha='e'.repeat(40);
  const r=evaluatePartitionedDag(graph,census);
  assert.ok(issue(r,'UNVERIFIED_EXACT_HEAD_CI',648));
  assert.ok(issue(r,'INVALID_MERGE_BASE',648));
  assert.ok(!r.review_candidates.some(x=>x.pr===648));
});

test('QA24 missing new open PR is a hard census barrier, never safe review',()=>{
  const {graph,census}=snapshot();
  census.ids.push(761);
  const r=evaluatePartitionedDag(graph,census);
  assert.ok(r.issues.some(x=>x.code==='STALE_OPEN_PR_CENSUS'));
  assert.equal(r.review_candidates.length,0);
});

test('QA24 100-result page cap and overlapping partitions reject merge candidate ranking',()=>{
  const {graph,census}=snapshot();
  census.segments[0]!.ids=Array.from({length:100},(_,i)=>i+1);
  const r=evaluatePartitionedDag(graph,census);
  assert.ok(r.issues.some(x=>x.code==='PAGINATION_OR_PARTITION_GAP'));
  assert.equal(r.review_candidates.length,0);
});

test('QA24 owner collision on two independent PRs blocks both source-only candidates',()=>{
  const {graph,census}=snapshot();
  get(graph,657).files.push(get(graph,648).files[0]!);
  const r=evaluatePartitionedDag(graph,census);
  assert.ok(r.collisions.some(x=>[x.a,x.b].includes(648)&&[x.a,x.b].includes(657)));
  assert.ok(!r.review_candidates.some(x=>x.pr===648||x.pr===657));
});

test('QA24 source-only green can only rank conditionally, never as merge authorization',()=>{
  const {graph,census}=snapshot(),r=evaluatePartitionedDag(graph,census);
  for(const pr of [648,657]) {
    const item=r.review_candidates.find(x=>x.pr===pr);
    assert.ok(item,`missing review candidate #${pr}`);
    assert.equal(item.rank,'CONDITIONAL_SOURCE_REVIEW_ONLY');
  }
  assert.ok(!r.review_candidates.some(x=>[669,670,675,676].includes(x.pr)));
  assert.equal(r.production_merge_authorized,false);
});

test('QA24 red CI child and green CI child of red owner both stay blocked',()=>{
  const {graph,census}=snapshot(),r=evaluatePartitionedDag(graph,census);
  assert.ok(issue(r,'NON_GREEN_MAIN_CI',754));
  assert.ok(issue(r,'RED_OR_STALE_ANCESTOR',670));
  assert.equal(r.gate,'NO_GO');
});

test('QA24 forged compare, broken file evidence, unknown parent and DAG cycle fail closed',()=>{
  const {graph,census}=snapshot();
  get(graph,648).compare!.merge_base_sha='f'.repeat(40);
  get(graph,657).files_complete=false;
  get(graph,698).base_ref='deleted-parent-branch';
  get(graph,701).base_ref=get(graph,701).head_ref;
  const r=evaluatePartitionedDag(graph,census);
  assert.ok(issue(r,'INVALID_MERGE_BASE',648));
  assert.ok(issue(r,'INCOMPLETE_CHANGED_FILES',657));
  assert.ok(issue(r,'UNRESOLVED_PARENT_REF',698));
  assert.ok(issue(r,'DEPENDENCY_CYCLE',701));
  assert.equal(r.review_candidates.some(x=>[648,657].includes(x.pr)),false);
});
