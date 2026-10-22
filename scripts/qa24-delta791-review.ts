/**
 * QA24 incremental 791-803 review. Historical 189 evidence reused, not rebuilt.
 * Source-only read; never a production or merging authority.
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {load781790} from './qa24-delta781-review.js';
import {evaluatePartitionedDag,type Census,type Pr,type Graph}
  from './qa24-partitioned-dag-review.js';

type Fixture={nodes:Pr[]};
const validSha=(s:string)=>/^[0-9a-f]{40}$/.test(s);
const target=Array.from({length:13},(_,i)=>791+i);
const sourceOnly=(p:string)=>p.startsWith('test/')||p.startsWith('docs/')||
  /^\.github\/workflows\/qa[-\w]*\.ya?ml$/.test(p);

export function reconcile791803(
 base:Graph,old15:Pr[],old6:Pr[],old10:Pr[],new13:Pr[],
 census:Census,changed:Pr[],owner718:{critical_owner:{head_sha:string;conclusion:string;primary_ci_run:number}}
) {
 const failures:string[]=[];
 const fail=(x:string)=>{if(!failures.includes(x))failures.push(x);};
 const sortedNew=new13.map(n=>n.pr).sort((a,b)=>a-b);
 if(base.nodes.length!==160||old15.length!==15||old6.length!==6||old10.length!==10)
   fail('INHERITED_SOURCE_INCOMPLETE');
 if(JSON.stringify(sortedNew)!==JSON.stringify(target))
   fail('DELTA_791_803_MISSING_OR_DUPLICATE');
 const by=new Map<number,Pr>(base.nodes.map(n=>[n.pr,n]));
 for(const n of [...old15,...old6,...old10,...new13]) {
   if(!n||!validSha(n.head_sha)||!validSha(n.base_sha)||!n.head_ref||!n.base_ref)
     fail('MISSING_SHA_OR_BRANCH');
   if(!n.ci||n.ci.queried_head_sha!==n.head_sha)
     fail('EXACT_CI_HEAD_INVALID');
   if(n.compare?.base_sha!==n.base_sha||n.compare?.head_sha!==n.head_sha||
      n.compare?.merge_base_sha!==n.base_sha||n.compare?.status!=='ahead')
     fail('COMPARE_UNVERIFIED');
   if(!n.files_complete||!Array.isArray(n.files)||n.files.length===0||
      new Set(n.files).size!==n.files.length)
     fail('CHANGED_FILE_SCOPE_UNKNOWN');
   by.set(n.pr,n);
 }
 for(const n of changed){
   if(!by.has(n.pr))fail('CHANGED_OWNER_UNKNOWN');
   if(n.ci.queried_head_sha!==n.head_sha||!validSha(n.head_sha))
     fail('CHANGED_OWNER_CI_UNVERIFIED');
   if(n.compare?.merge_base_sha!==n.base_sha||n.compare?.status!=='ahead')
     fail('CHANGED_OWNER_MERGE_BASE_RISK');
   by.set(n.pr,n);
 }
 if(by.size!==202)fail('KNOWN_NODE_COUNT_NOT_202');
 const nodes=[...by.values()].sort((a,b)=>a.pr-b.pr);
 const graph={...base,nodes,census_count_at_capture:census.ids.length,
   coverage:{missing:[],extras:[]}};
 const audit=evaluatePartitionedDag(graph,census);
 const allIds=census.segments.flatMap(s=>s.ids);
 if(census.segments.some(s=>s.ids.length===0||s.ids.length>=100)||
    new Set(allIds).size!==allIds.length||
    JSON.stringify(allIds.slice().sort((a,b)=>a-b))!==
    JSON.stringify(census.ids.slice().sort((a,b)=>a-b)))
   fail('INCOMPLETE_PARTITIONED_CENSUS');
 const missing=census.ids.filter(id=>!by.has(id)).sort((a,b)=>a-b);
 const noLongerOpen=nodes.filter(n=>!census.ids.includes(n.pr)).map(n=>n.pr);
 if(missing.length||noLongerOpen.length)fail('LIVE_ID_SET_NOT_COVERED');
 const issue=(code:string)=>audit.issues.filter(x=>x.code===code);
 const branches=new Map(nodes.map(n=>[n.head_ref,n.pr]));
 const parent=(n:Pr)=>branches.get(n.base_ref)??null;
 const chain=(id:number)=>{
   const visited=new Set([id]),ids:number[]=[];let current=by.get(id);
   while(current){
     const p=parent(current);
     if(p===null||visited.has(p))break;
     visited.add(p);ids.push(p);current=by.get(p);
   }
   return ids;
 };
 const dependencyOrder=new13.map(n=>{
   const parents=chain(n.pr);
   const redParent=parents.filter(id=>{
     const a=by.get(id);
     return !a||a.ci.status!=='completed'||a.ci.conclusion!=='success'||
       a.ci.queried_head_sha!==a.head_sha||
       a.compare?.merge_base_sha!==a.base_sha||a.compare.status!=='ahead';
   });
   const overlaps=audit.collisions.filter(c=>[c.a,c.b].includes(n.pr));
   const blockers=[
     ...(n.ci.status==='completed'&&n.ci.conclusion==='success'?[]:['NON_GREEN_EXACT_CI']),
     ...(redParent.length?['RED_OR_UNKNOWN_ANCESTOR']:[]),
     ...(overlaps.length?['INDEPENDENT_OWNER_COLLISION']:[]),
     ...(n.base_ref==='main'||parent(n)!==null?[]:['UNRESOLVED_PARENT']),
     ...(n.compare?.status==='ahead'&&n.compare.merge_base_sha===n.base_sha?[]:['BAD_MERGE_BASE']),
     ...(!n.files.every(sourceOnly)?['NON_SOURCE_ONLY']:[])
   ];
   return {pr:n.pr,head_sha:n.head_sha,parent_chain_from_nearest:parents,
     red_or_unknown_parents:redParent,review_after_prs:parents.slice().reverse(),
     exact_ci_run:n.ci.run_id,exact_ci:n.ci.conclusion??n.ci.status,
     owner_collisions:overlaps.length,blockers,
     label: blockers.length?'BLOCKED_OR_OWNER_REVIEW':'FROZEN_SOURCE_REVIEW_ONLY'};
 });
 const historical718=by.get(718);
 if(historical718?.head_sha!==owner718.critical_owner.head_sha||
    owner718.critical_owner.conclusion!=='failure')fail('STORED_718_HEAD_STALE');
 if(changed.some(n=>n.pr===708&&n.compare?.status!=='ahead'))
   fail('708_DIVERGED_MERGE_BASE');
 if(changed.some(n=>n.pr===726&&n.ci.conclusion!=='success'))
   fail('726_EXACT_RED_CI');
 return {
   gate:'NO_GO' as const,production_merge_authorized:false as const,
   current_safe_merge_candidates:[] as never[],
   full_live_head_ci_reverified:false as const,
   observed_open_ids:census.ids.length,known_nodes:by.size,
   missing_ids:missing,no_longer_open:noLongerOpen,
   dependency_edges:audit.edges,
   independent_owner_overlap_pairs:audit.collision_count,
   new_overlap_pairs:audit.collisions.filter(c=>c.a>=791||c.b>=791),
   stale_parents:issue('STALE_PARENT_HEAD'),
   unresolved_parents:issue('UNRESOLVED_PARENT_REF'),
   red_ancestors:issue('RED_OR_STALE_ANCESTOR'),
   invalid_merge_base:issue('INVALID_MERGE_BASE'),
   owner708:changed.find(n=>n.pr===708),
   owner726:changed.find(n=>n.pr===726),
   owner718_current_witness:owner718.critical_owner,
   delta_primary_ci:new13.map(n=>({pr:n.pr,head_sha:n.head_sha,
     run_id:n.ci.run_id,status:n.ci.status,conclusion:n.ci.conclusion})),
   source_dependency_review_order:dependencyOrder,
   source_review_candidates_only:[781,657,648],
   failures
 };
}
export function load791803(){
 const read=(p:string)=>JSON.parse(readFileSync(fileURLToPath(new URL(p,import.meta.url)),'utf8'));
 const {graph,delta,newDelta,ten,owner}=load781790();
 const new13=['791-794','795-798','799-803'].flatMap(s=>
   (read('../docs/qa/fixtures/qa24-delta-'+s+'.json') as Fixture).nodes);
 const changed=(read('../docs/qa/fixtures/qa24-current-708-726-witness.json') as Fixture).nodes;
 const census=read('../docs/qa/fixtures/qa24-open-census-791-803.json') as Census;
 return {graph,delta,newDelta,ten,new13,census,changed,owner};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const a=load791803();
 process.stdout.write(JSON.stringify(reconcile791803(a.graph,a.delta,a.newDelta,a.ten,
   a.new13,a.census,a.changed,a.owner),null,2)+'\n');
 process.exitCode=2;
}
