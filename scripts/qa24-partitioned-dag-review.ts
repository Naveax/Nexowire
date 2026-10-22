/**
 * QA24 / deterministic offline review. Reads only committed GitHub evidence.
 * No network, merges, CI reruns, production, UAC or Agent effects.
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export type Pr={pr:number;head_sha:string;head_ref:string;base_sha:string;base_ref:string;
  files:string[];files_complete:boolean;
  ci:{run_id:number|null;status:string;conclusion:string|null;queried_head_sha:string};
  compare?:{base_sha:string;head_sha:string;merge_base_sha:string|null;status:string};
};
export type Graph={nodes:Pr[];main_head:string;census_count_at_capture:number;
  coverage?:{missing?:number[];extras?:number[]}};
export type Census={ids:number[];segments:Array<{query:string;ids:number[]}>};
export type Issue={code:string;prs:number[];detail:string};
const sha=/^[0-9a-f]{40}$/;
const sourcePath=(p:string)=>p.startsWith('test/')||p.startsWith('docs/')||
  /^\.github\/workflows\/qa[-\w]*\.ya?ml$/.test(p)||
  /^scripts\/qa24[-\w]*\.ts$/.test(p);
const sorted=(ns:Iterable<number>)=>[...ns].sort((a,b)=>a-b);

export function evaluatePartitionedDag(graph:Graph,census:Census) {
  const errors:Issue[]=[];
  const add=(code:string,prs:number[],detail:string)=>errors.push({code,prs,detail});
  const nodes=new Map<number,Pr>(),branches=new Map<string,number>();
  if(!sha.test(graph.main_head))add('BAD_MAIN_SHA',[],'Invalid main head');
  for(const n of graph.nodes) {
    if(nodes.has(n.pr))add('DUPLICATE_PR',[n.pr],'Duplicate PR');
    if(!n.head_ref||branches.has(n.head_ref))add('MISSING_OR_DUPLICATE_HEAD_REF',[n.pr],
      'Head ref absent or claimed by another PR');
    nodes.set(n.pr,n);
    if(n.head_ref)branches.set(n.head_ref,n.pr);
  }
  const allIds=sorted(census.ids),nodeIds=sorted(nodes.keys());
  const segmentIds=census.segments.flatMap(s=>s.ids);
  if(census.segments.some(s=>s.ids.length>=100)||
     new Set(segmentIds).size!==segmentIds.length||
     JSON.stringify(sorted(segmentIds))!==JSON.stringify(allIds))
    add('PAGINATION_OR_PARTITION_GAP',[],'Segment capped, duplicated or incomplete');
  if(JSON.stringify(allIds)!==JSON.stringify(nodeIds)||
     graph.census_count_at_capture!==allIds.length||
     (graph.coverage?.missing?.length??0)>0||
     (graph.coverage?.extras?.length??0)>0)
    add('STALE_OPEN_PR_CENSUS',[],'Open PR IDs disagree; a live recheck is mandatory');

  const parents=new Map<number,number|null>(),collisions: Array<{a:number;b:number;files:string[]}>= [];
  for(const n of graph.nodes) {
    parents.set(n.pr,n.base_ref==='main'?null:branches.get(n.base_ref)??null);
    if(!sha.test(n.head_sha)||!sha.test(n.base_sha))add('BAD_PR_SHA',[n.pr],'Malformed SHA');
    if(!n.files_complete||!Array.isArray(n.files)||!n.files.length||
       n.files.some(f=>!f)||new Set(n.files).size!==n.files.length)
      add('INCOMPLETE_CHANGED_FILES',[n.pr],'Changed file list incomplete');
    if(n.compare?.head_sha!==n.head_sha||n.compare?.base_sha!==n.base_sha||
       n.compare?.merge_base_sha!==n.base_sha||n.compare?.status!=='ahead')
      add('INVALID_MERGE_BASE',[n.pr],'Exact SHA compare missing, stale or not ahead');
    if(n.ci.queried_head_sha!==n.head_sha||(typeof n.ci.run_id!=='number'||!Number.isSafeInteger(n.ci.run_id))||
       (n.ci.run_id??0)<=0)
      add('UNVERIFIED_EXACT_HEAD_CI',[n.pr],'CI run missing or for an old SHA');
    else if(n.ci.status!=='completed'||n.ci.conclusion!=='success')
      add('NON_GREEN_MAIN_CI',[n.pr],`CI ${n.ci.status}/${n.ci.conclusion}`);
    if(n.base_ref==='main'&&n.base_sha!==graph.main_head)
      add('STALE_MAIN_BASE',[n.pr],'PR based on older main commit');
    if(n.base_ref!=='main'&&!branches.has(n.base_ref))
      add('UNRESOLVED_PARENT_REF',[n.pr],n.base_ref);
    const parent=parents.get(n.pr);
    if(parent!=null&&nodes.get(parent)?.head_sha!==n.base_sha)
      add('STALE_PARENT_HEAD',[n.pr,parent],'Base SHA != current parent HEAD');
  }
  const ancestry=(pr:number):{parents:number[];cycle:boolean}=>{
    const ancestors:number[]=[],visited=new Set([pr]);let curr=pr;
    while(true) {
      const p=parents.get(curr);
      if(p==null)return {parents:ancestors,cycle:false};
      if(visited.has(p))return {parents:ancestors,cycle:true};
      visited.add(p);ancestors.push(p);curr=p;
    }
  };
  const ancestryMap=new Map<number,number[]>();
  for(const n of graph.nodes) {
    const chain=ancestry(n.pr);
    ancestryMap.set(n.pr,chain.parents);
    if(chain.cycle)add('DEPENDENCY_CYCLE',[n.pr],'Cycle in PR parent DAG');
    if(chain.parents.some(p=>{
      const x=nodes.get(p);
      return !x||x.ci.conclusion!=='success'||x.ci.status!=='completed'||
        x.ci.queried_head_sha!==x.head_sha||
        x.base_ref==='main'&&x.base_sha!==graph.main_head||
        x.base_ref!=='main'&&nodes.get(branches.get(x.base_ref)??-1)?.head_sha!==x.base_sha;
    }))add('RED_OR_STALE_ANCESTOR',[n.pr],'Inherited failure or stale owner authority');
  }
  const entries=[...nodes.values()].sort((a,b)=>a.pr-b.pr);
  for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++){
    const a=entries[i]!,b=entries[j]!;
    if(ancestryMap.get(a.pr)?.includes(b.pr)||ancestryMap.get(b.pr)?.includes(a.pr))continue;
    const bset=new Set(b.files??[]);
    const common=[...new Set((a.files??[]).filter(f=>bset.has(f)))].sort();
    if(common.length)collisions.push({a:a.pr,b:b.pr,files:common});
  }
  for(const c of collisions)add('INDEPENDENT_OWNER_COLLISION',[c.a,c.b],c.files.join(', '));
  const hardBlock=new Set(errors.filter(e=>e.code!=='INDEPENDENT_OWNER_COLLISION').flatMap(e=>e.prs));
  const collisionBlocks=new Set(collisions.flatMap(c=>[c.a,c.b]));
  const globalGap=errors.some(e=>['PAGINATION_OR_PARTITION_GAP','STALE_OPEN_PR_CENSUS','BAD_MAIN_SHA',
    'DUPLICATE_PR','MISSING_OR_DUPLICATE_HEAD_REF','DEPENDENCY_CYCLE'].includes(e.code));
  const candidates=entries.filter(n=>!globalGap&&n.base_ref==='main'&&
    !hardBlock.has(n.pr)&&!collisionBlocks.has(n.pr)&&
    n.files.every(sourcePath)&&n.ci.status==='completed'&&n.ci.conclusion==='success')
    .map(n=>({pr:n.pr,head_sha:n.head_sha,ci_run_id:n.ci.run_id,
      rank:'CONDITIONAL_SOURCE_REVIEW_ONLY',changed_file_count:n.files.length,
      next_action:'Refresh entire open PR set, exact HEAD CI, merge-base, owner paths and branch protection before any merge'}))
    .sort((a,b)=>a.changed_file_count-b.changed_file_count||a.pr-b.pr);
  return {gate:'NO_GO' as const,production_merge_authorized:false as const,
    live_freshness_verified:false as const,captured_open_count:census.ids.length,
    nodes:graph.nodes.length,edges:[...parents.values()].filter(x=>x!==null).length,
    ci_unknown:graph.nodes.filter(n=>n.ci.conclusion==null).map(n=>n.pr),
    collision_count:collisions.length,collisions,issues:errors,review_candidates:candidates};
}

export function loadPinnedGraph():{graph:Graph;census:Census} {
  const read=(p:string)=>JSON.parse(readFileSync(fileURLToPath(new URL(p,import.meta.url)),'utf8'));
  const graph=read('../docs/qa/p0-open-dag-160-source-20261022.json') as Graph;
  const census=read('../docs/qa/fixtures/qa24-open-census-current-20261022.json') as Census;
  return {graph,census};
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]) {
  const {graph,census}=loadPinnedGraph();
  process.stdout.write(JSON.stringify(evaluatePartitionedDag(graph,census),null,2)+'\n');
  process.exitCode=2; // Intentionally no merge authority even if snapshot passes.
}
