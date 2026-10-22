/**
 * #24 incremental reconciliation. Uses existing 160+15+6 source fixtures:
 * only #781–#790 are appended. No GitHub mutation or merge authority.
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {load774779} from './qa24-delta774-review.js';
import {evaluatePartitionedDag,type Graph,type Census,type Pr}
  from './qa24-partitioned-dag-review.js';

type Fixture={nodes:Pr[]};
type OwnerWitness={critical_owner:{pr:number;head_sha:string;primary_ci_run:number;conclusion:string}};
const sha=/^[0-9a-f]{40}$/;
const targetIds=Array.from({length:10},(_,i)=>i+781);
const rankedSourcePath=(p:string)=>p.startsWith('test/')||p.startsWith('docs/')||
 /^\.github\/workflows\/qa[-\w]*\.ya?ml$/.test(p)||
 /^scripts\/qa24[-\w]*\.ts$/.test(p);

export function reconcile781790(
  base:Graph,prior15:Pr[],prior6:Pr[],ten:Pr[],
  census:Census,owner:OwnerWitness
) {
  const fail:string[]=[];
  const error=(code:string)=>{if(!fail.includes(code))fail.push(code);};
  if(base.nodes.length!==160||prior15.length!==15||prior6.length!==6)
    error('BASELINE_SOURCE_INCOMPLETE');
  if(JSON.stringify(ten.map(n=>n.pr).sort((a,b)=>a-b))!==JSON.stringify(targetIds))
    error('DELTA_781_790_DUPLICATE_OR_INCOMPLETE');
  const by=new Map<number,Pr>(base.nodes.map(n=>[n.pr,n]));
  if(by.size!==base.nodes.length)error('DUPLICATE_BASELINE_NODE');
  for(const n of [...prior15,...prior6,...ten]) {
    if(!n||!sha.test(n.head_sha)||!sha.test(n.base_sha)||!n.head_ref||!n.base_ref)
      error('MISSING_REF_OR_BAD_SHA');
    if(n.ci?.queried_head_sha!==n.head_sha)
      error('EXACT_HEAD_CI_REF_MISMATCH');
    if(!n.compare||n.compare.head_sha!==n.head_sha||
      n.compare.base_sha!==n.base_sha||
      n.compare.merge_base_sha!==n.base_sha||n.compare.status!=='ahead')
      error('INVALID_SHA_BOUND_MERGE_BASE');
    if(!n.files_complete||!Array.isArray(n.files)||!n.files.length||
       n.files.some(p=>!p))
      error('OWNER_FILES_INCOMPLETE');
    by.set(n.pr,n);
  }
  if(by.size!==189)error('INCREMENTAL_GRAPH_NODE_COUNT_CHANGED');
  const nodes=[...by.values()].sort((a,b)=>a.pr-b.pr);
  const observedIds=census.ids.slice().sort((a,b)=>a-b);
  const segmentIds=census.segments.flatMap(x=>x.ids).sort((a,b)=>a-b);
  if(census.segments.some(x=>x.ids.length===0||x.ids.length>=100)||
    new Set(segmentIds).size!==segmentIds.length||
    JSON.stringify(segmentIds)!==JSON.stringify(observedIds))
    error('PAGINATION_PARTITION_GAP_OR_DUPLICATE');
  const missingFromDetails=observedIds.filter(id=>!by.has(id));
  const noLongerOpen=[...by.keys()].filter(id=>!observedIds.includes(id)).sort((a,b)=>a-b);
  if(missingFromDetails.length||noLongerOpen.length)
    error('LIVE_OPEN_SET_NOT_FULLY_COVERED');
  const graph:Graph={...base,nodes,census_count_at_capture:observedIds.length,
    coverage:{missing:[],extras:[]}};
  const audit=evaluatePartitionedDag(graph,census);
  const historical718=by.get(718);
  const ownerHeadDrift=!historical718||
     historical718.head_sha!==owner.critical_owner.head_sha;
  if(owner.critical_owner.pr!==718||
     !sha.test(owner.critical_owner.head_sha)||
     owner.critical_owner.conclusion!=='failure')
    error('OWNER_718_WITNESS_MISSING_OR_INVALID');
  if(ownerHeadDrift)error('HISTORICAL_718_HEAD_DRIFT');
  if(audit.issues.some(x=>x.code==='STALE_OPEN_PR_CENSUS'))
    error('STALE_OPEN_CENSUS');
  const knownIds=nodes.map(n=>n.pr);
  const candidateCensus:Census={...census,ids:knownIds,
    segments:census.segments.map(s=>({...s,ids:s.ids.filter(id=>by.has(id))}))};
  const frozen=evaluatePartitionedDag(
    {...graph,census_count_at_capture:knownIds.length},candidateCensus);
  const rankedReview=frozen.review_candidates
    .filter(x=>ten.some(n=>n.pr===x.pr)||[648,657].includes(x.pr))
    .filter(x=>rankedSourcePath(nodes.find(n=>n.pr===x.pr)?.files[0]??''))
    .map(x=>({...x,rank:'CONDITIONAL_SOURCE_REVIEW_ONLY' as const,
      production_merge_authorized:false as const}));
  return {
    gate:'NO_GO' as const,production_merge_authorized:false as const,
    current_safe_merge_candidates:[] as never[],
    live_full_head_revalidation:false as const,source_snapshot_stale:true as const,
    issue_780:{type:'P1_PRODUCT_EPIC',is_mergeable_pr:false},
    known_nodes:audit.nodes,recorded_open_count:census.ids.length,
    missingFromDetails,noLongerOpen,dependency_edges:audit.edges,
    total_owner_collision_pairs:audit.collision_count,
    new_owner_collision_pairs:audit.collisions.filter(c=>c.a>=781||c.b>=781),
    stale_parent:audit.issues.filter(x=>x.code==='STALE_PARENT_HEAD'),
    unresolved_parent:audit.issues.filter(x=>x.code==='UNRESOLVED_PARENT_REF'),
    red_or_stale_ancestor:audit.issues.filter(x=>x.code==='RED_OR_STALE_ANCESTOR'),
    owner718:{recorded_head:historical718?.head_sha??null,
      current_exact_head:owner.critical_owner.head_sha,
      exact_run:owner.critical_owner.primary_ci_run,
      ci_conclusion:owner.critical_owner.conclusion,
      historical_head_moved:ownerHeadDrift},
    exact_primary_ci:ten.map(n=>({pr:n.pr,head_sha:n.head_sha,
      run_id:n.ci.run_id,status:n.ci.status,conclusion:n.ci.conclusion})),
    frozen_conditional_source_review:rankedReview,
    failures:fail,
    next_action:'NO MERGES. Refresh every open HEAD/base/main CI/changed file/merge-base including missing IDs; independent #00 review and P0 physical evidence required.'
  };
}
export function load781790() {
  const read=(path:string)=>JSON.parse(readFileSync(fileURLToPath(new URL(path,import.meta.url)),'utf8'));
  const {graph,delta,newDelta}=load774779();
  const ten=[
    ...(read('../docs/qa/fixtures/qa24-delta-781-785.json') as Fixture).nodes,
    ...(read('../docs/qa/fixtures/qa24-delta-786-790.json') as Fixture).nodes
  ];
  const census=read('../docs/qa/fixtures/qa24-open-census-781-790.json') as Census;
  const owner=read('../docs/qa/fixtures/qa24-owner718-current-ci-20261022.json') as OwnerWitness;
  return {graph,delta,newDelta,ten,census,owner};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const {graph,delta,newDelta,ten,census,owner}=load781790();
  process.stdout.write(JSON.stringify(reconcile781790(graph,delta,newDelta,ten,census,owner),null,2)+'\n');
  process.exitCode=2;
}
