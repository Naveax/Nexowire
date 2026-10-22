/**
 * QA24 incremental source-only delta reconciliation for existing 160-PR frozen DAG.
 * No network/write/merges; source evidence is only as fresh as pinned exact SHAs.
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {evaluatePartitionedDag,loadPinnedGraph,type Graph,type Census,type Pr}
  from './qa24-partitioned-dag-review.js';

type DeltaFile={nodes:Array<Pr & {error?:string}>};
const sha=/^[0-9a-f]{40}$/;
export const DELTA_START=759,DELTA_END=773;

export function reconcileIncremental(base:Graph,census:Census,delta:Pr[]) {
  const failures:string[]=[];
  const fail=(c:string)=>{if(!failures.includes(c))failures.push(c);};
  if(base.nodes.length!==160||new Set(base.nodes.map(n=>n.pr)).size!==160)
    fail('BASELINE_160_INVALID');
  const expected=Array.from({length:DELTA_END-DELTA_START+1},(_,i)=>DELTA_START+i);
  const ids=delta.map(n=>n.pr).sort((a,b)=>a-b);
  if(JSON.stringify(ids)!==JSON.stringify(expected))fail('DELTA_RANGE_OR_DUPLICATES');
  const first=new Map<number,Pr>(base.nodes.map(n=>[n.pr,n]));
  for(const n of delta){
    if(!n||!sha.test(n.head_sha)||!sha.test(n.base_sha)||!n.head_ref||!n.base_ref)
      fail('DELTA_MISSING_SHA_OR_REF');
    if(n.ci?.queried_head_sha!==n.head_sha)fail('DELTA_CI_HEAD_MISMATCH');
    if(n.compare?.head_sha!==n.head_sha||n.compare?.base_sha!==n.base_sha||
       n.compare?.merge_base_sha!==n.base_sha||n.compare?.status!=='ahead')
      fail('DELTA_MERGE_BASE_MISSING_OR_STALE');
    if(!n.files_complete||!Array.isArray(n.files)||n.files.length===0)
      fail('DELTA_OWNER_PATHS_MISSING');
    first.set(n.pr,n);
  }
  const nodes=[...first.values()].sort((a,b)=>a.pr-b.pr);
  const expectedIds=[...first.keys()].sort((a,b)=>a-b);
  if(nodes.length!==173)fail('MERGED_173_INVALID');

  const actualGraph:Graph={...base,nodes,census_count_at_capture:census.ids.length};
  const actual=evaluatePartitionedDag(actualGraph,census);
  const known=new Set(expectedIds);
  const censused=new Set(census.ids);
  const missingCurrentIds=census.ids.filter(id=>!first.has(id)).sort((a,b)=>a-b);
  const noLongerOpenIds=expectedIds.filter(id=>!censused.has(id));
  const censusBad=census.segments.some(x=>x.ids.length>=100)||
    new Set(census.segments.flatMap(x=>x.ids)).size!==census.ids.length;
  if(missingCurrentIds.length||noLongerOpenIds.length||censusBad)
    fail('LIVE_CENSUS_DIFFERS_FROM_PINNED_DETAILS');

  // This subset-only calculation is NOT an authorization: historical heads
  // outside #759-773 are not live revalidated. Keep candidates distinct.
  const hypothetical:Census={
    ...census,ids:expectedIds,
    segments:census.segments.map(s=>({...s,ids:s.ids.filter(id=>known.has(id))}))
  };
  const closedReview=evaluatePartitionedDag({...base,nodes,census_count_at_capture:nodes.length},
    hypothetical);
  const shortlist=failures.length===0||failures.every(f=>f==='LIVE_CENSUS_DIFFERS_FROM_PINNED_DETAILS')
    ?closedReview.review_candidates
    :[];
  // External CI can be queued, unknown, or absent even when source path is clear.
  const deltaCi=delta.map(n=>({pr:n.pr,head_sha:n.head_sha,base_sha:n.base_sha,
    ci_run_id:n.ci?.run_id??null,ci_status:n.ci?.status??'unknown',
    ci_conclusion:n.ci?.conclusion??null}));
  return {
    gate:'NO_GO' as const, production_merge_authorized:false as const,
    live_set_freshly_revalidated:false as const,
    pinned_baseline:base.nodes.length,pinned_delta:delta.length,
    pinned_merged:actual.nodes,census_observed:census.ids.length,
    missingCurrentIds,noLongerOpenIds,
    stale_parent:actual.issues.filter(x=>x.code==='STALE_PARENT_HEAD')
      .flatMap(x=>x.prs.slice(0,1)).sort((a,b)=>a-b),
    missing_or_stale_sha_ci:actual.issues.filter(x=>x.code==='UNVERIFIED_EXACT_HEAD_CI'),
    invalid_merge_bases:actual.issues.filter(x=>x.code==='INVALID_MERGE_BASE'),
    unresolved_parent_refs:actual.issues.filter(x=>x.code==='UNRESOLVED_PARENT_REF'),
    changed_file_errors:actual.issues.filter(x=>x.code==='INCOMPLETE_CHANGED_FILES'),
    red_or_stale_ancestors:actual.issues.filter(x=>x.code==='RED_OR_STALE_ANCESTOR'),
    owner_collision_pairs:actual.collision_count,
    delta_ci:deltaCi,failures,
    // An offline shortlist, blocked from merge until FULL fresh all-open scan.
    frozen_source_review_candidates:shortlist,
    current_safe_merge_candidates:[] as never[]
  };
}

export function loadIncremental() {
  const read=(s:string)=>JSON.parse(readFileSync(fileURLToPath(new URL(s,import.meta.url)),'utf8'));
  const {graph}=loadPinnedGraph();
  const census=read('../docs/qa/fixtures/qa24-open-census-delta-20261022.json') as Census;
  const paths=['759-762','763-765','766-768','769-771','772-773'];
  const delta=paths.flatMap(p=>(read(`../docs/qa/fixtures/qa24-delta-${p}.json`) as DeltaFile).nodes);
  return {graph,census,delta};
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]) {
  const {graph,census,delta}=loadIncremental();
  process.stdout.write(JSON.stringify(reconcileIncremental(graph,census,delta),null,2)+'\n');
  process.exitCode=2; // Never an authority to merge.
}
