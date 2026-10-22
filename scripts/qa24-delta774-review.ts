/**
 * #24: incremental QA ONLY. Overlay six exact-HEAD PRs on the prior 160+15 DAG.
 * Frozen evidence cannot authorize merging or prove current GitHub freshness.
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {loadIncremental} from './qa24-delta-review.js';
import {evaluatePartitionedDag,type Census,type Graph,type Pr}
  from './qa24-partitioned-dag-review.js';

type Fixture={nodes:Pr[]};
const sha=/^[0-9a-f]{40}$/;
export const DELTA_774_779=[774,775,776,777,778,779] as const;

export function reconcile774779(
  baseline:Graph, oldDelta:Pr[], six:Pr[], census:Census
) {
  const errors:string[]=[];
  const fail=(x:string)=>{if(!errors.includes(x))errors.push(x);};
  if(baseline.nodes.length!==160||oldDelta.length!==15)
    fail('INHERITED_EVIDENCE_INCOMPLETE');
  const sixIds=six.map(n=>n.pr).sort((a,b)=>a-b);
  if(JSON.stringify(sixIds)!==JSON.stringify(DELTA_774_779))
    fail('DELTA_774_779_MISSING_OR_DUPLICATED');
  const by=new Map<number,Pr>(baseline.nodes.map(n=>[n.pr,n]));
  if(by.size!==baseline.nodes.length)fail('DUPLICATE_BASELINE_PR');
  for(const n of [...oldDelta,...six]) {
    if(!n||!sha.test(n.head_sha)||!sha.test(n.base_sha)||!n.head_ref||!n.base_ref)
      fail('MISSING_HEAD_BASE_OR_PARENT');
    if(n.ci?.queried_head_sha!==n.head_sha)
      fail('EXACT_HEAD_CI_MISMATCH');
    if(!n.compare||n.compare.head_sha!==n.head_sha||
      n.compare.base_sha!==n.base_sha||
      n.compare.merge_base_sha!==n.base_sha||n.compare.status!=='ahead')
      fail('MISSING_OR_STALE_MERGE_BASE');
    if(!n.files_complete||!Array.isArray(n.files)||n.files.length===0)
      fail('MISSING_CHANGED_FILE_PROOF');
    by.set(n.pr,n);
  }
  if(by.size!==179)fail('EXPECTED_179_DISTINCT_NODES');
  const nodes=[...by.values()].sort((a,b)=>a.pr-b.pr);
  const ids=census.ids.slice().sort((a,b)=>a-b);
  if(census.segments.some(s=>s.ids.length===0||s.ids.length>=100)||
     new Set(census.segments.flatMap(s=>s.ids)).size!==census.ids.length||
     JSON.stringify(census.segments.flatMap(s=>s.ids).sort((a,b)=>a-b))!==JSON.stringify(ids))
    fail('PARTITION_CAPPED_DUPLICATED_OR_INCOMPLETE');
  const missingIds=ids.filter(id=>!by.has(id));
  const noLongerOpen=[...by.keys()].filter(id=>!ids.includes(id)).sort((a,b)=>a-b);
  if(missingIds.length||noLongerOpen.length||census.ids.length!==by.size)
    fail('OPEN_SET_DRIFT');
  const graph={...baseline,nodes,census_count_at_capture:ids.length};
  const result=evaluatePartitionedDag(graph,census);
  const deltaStatus=six.map(n=>({
    pr:n.pr,head_sha:n.head_sha,base_sha:n.base_sha,
    primary_ci_run:n.ci?.run_id??null,
    primary_ci_status:n.ci?.status??'unknown',
    primary_ci_conclusion:n.ci?.conclusion??null
  }));
  return {
    gate:'NO_GO' as const,production_p0_merge_authorized:false as const,
    roadmap_issue_780:{kind:'P1_PRODUCT_EPIC',mergeable_pr:false},
    frozen_capture_only:true,live_freshness_verified:false,
    baseline_nodes:baseline.nodes.length,previous_delta_nodes:oldDelta.length,
    new_delta_nodes:six.length,known_nodes:result.nodes,
    captured_open_count:census.ids.length,dag_edges:result.edges,
    owner_collision_pairs:result.collision_count,
    independent_delta_overlaps:result.collisions.filter(
      c=>DELTA_774_779.includes(c.a as typeof DELTA_774_779[number])||
         DELTA_774_779.includes(c.b as typeof DELTA_774_779[number])
    ),
    missingIds,noLongerOpen,failures:errors,
    stale_parent:result.issues.filter(x=>x.code==='STALE_PARENT_HEAD')
      .map(x=>x.prs[0]).filter((x):x is number=>x!==undefined).sort((a,b)=>a-b),
    unresolved_parent:result.issues.filter(x=>x.code==='UNRESOLVED_PARENT_REF'),
    red_or_stale_ancestor:result.issues.filter(x=>x.code==='RED_OR_STALE_ANCESTOR'),
    unverified_ci:result.issues.filter(x=>x.code==='UNVERIFIED_EXACT_HEAD_CI'),
    bad_merge_base:result.issues.filter(x=>x.code==='INVALID_MERGE_BASE'),
    delta_status:deltaStatus,
    conditional_source_only_review:errors.length===0?result.review_candidates:[],
    current_safe_merge_candidates:[] as never[],
    next_action:'Requery entire currently-open set and SHA/primary CI/file/merge-base, enforce code-owner approval and branch protection before any merge'
  };
}
export function load774779() {
  const read=(p:string)=>JSON.parse(readFileSync(fileURLToPath(new URL(p,import.meta.url)),'utf8'));
  const {graph,delta}=loadIncremental();
  const newDelta=[
    ...(read('../docs/qa/fixtures/qa24-delta-774-776.json') as Fixture).nodes,
    ...(read('../docs/qa/fixtures/qa24-delta-777-779.json') as Fixture).nodes
  ];
  const census=read('../docs/qa/fixtures/qa24-open-census-774-779-20261022.json') as Census;
  return {graph,delta,newDelta,census};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const {graph,delta,newDelta,census}=load774779();
  process.stdout.write(JSON.stringify(reconcile774779(graph,delta,newDelta,census),null,2)+'\n');
  process.exitCode=2; // There is no automatic P0 merge path.
}
