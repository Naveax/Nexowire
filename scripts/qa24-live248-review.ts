/**
 * QA24 independent post-capture evidence review.
 * NO remote actions, no merges, no implicit physical or native CAS acceptance.
 * Real two-pass GitHub REST refs and exact-scoped CI/files/compare are frozen JSON.
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

type Ref={pr:number;head:string;base:string;head_ref:string;base_ref:string;state:string};
type Ci={run_id:number|null;status:string;conclusion:string|null;queried_head_sha:string};
type Critical=Ref & {ci:Ci;compare:{merge_base:string|null;status:string|null;base_sha:string;head_sha:string};files:string[]};
type Census={refs_equal:boolean;first_counts:number[];second_counts:number[];first_count:number;second_count:number;refs:Ref[]};
export type Evidence={census:Census;records:Critical[];main:string};
const sha=/^[0-9a-f]{40}$/;
const sorted=(numbers:number[])=>[...numbers].sort((a,b)=>a-b);
const issue=(code:string,prs:number[]=[])=>({code,prs});
export function reviewLive248Evidence(data:Evidence) {
  const issues:Array<{code:string;prs:number[]}>=[],add=(code:string,prs:number[]=[])=>issues.push(issue(code,prs));
  const c=data.census,refs=c.refs??[];
  const paged=c.refs_equal===true&&JSON.stringify(c.first_counts)===JSON.stringify(c.second_counts)&&
    c.first_counts?.at(-1)===0&&c.first_counts?.slice(0,-2).every(n=>n===100)&&
    c.first_counts?.at(-2)>0&&c.first_counts?.at(-2)<100&&
    c.first_count===refs.length&&c.second_count===refs.length&&refs.length>0;
  if(!paged)add('OPEN_REST_TWO_PASS_INCOMPLETE');
  if(!sha.test(data.main))add('MAIN_SHA_NOT_VERIFIED');
  const by=new Map<number,Ref>(),byHeadRef=new Map<string,Ref>();
  for(const n of refs) {
    if(!Number.isSafeInteger(n.pr)||n.pr<1||!sha.test(n.head)||!sha.test(n.base)||!n.head_ref||!n.base_ref||
       n.state!=='open'||by.has(n.pr)||byHeadRef.has(n.head_ref))
      add('PR_DUPLICATE_OR_BAD_REF',[n.pr]);
    by.set(n.pr,n);
    byHeadRef.set(n.head_ref,n);
    if(n.base_ref==='main'&&n.base!==data.main)
      add('STALE_MAIN_BASE',[n.pr]);
  }
  const edges=refs.filter(n=>byHeadRef.has(n.base_ref)).map(n=>{
    const p=byHeadRef.get(n.base_ref)!;
    return {parent:p.pr,child:n.pr,base_sha:n.base,parent_head:p.head,stale:n.base!==p.head};
  });
  const stale=edges.filter(e=>e.stale);
  const unresolved=refs.filter(n=>n.base_ref!=='main'&&!byHeadRef.has(n.base_ref))
    .map(n=>({pr:n.pr,base_ref:n.base_ref}));
  const ancestor=(child:number,lookFor:number)=>{
    let n=by.get(child),seen=new Set<number>([child]);
    while(n&&byHeadRef.has(n.base_ref)) {
      const p=byHeadRef.get(n.base_ref)!;
      if(p.pr===lookFor)return true;
      if(seen.has(p.pr))return false;
      seen.add(p.pr);n=p;
    }
    return false;
  };
  const unique=new Set<number>();
  for(const n of data.records) {
    const ref=by.get(n.pr);
    if(unique.has(n.pr)||!ref||ref.head!==n.head||ref.base!==n.base||
       ref.head_ref!==n.head_ref||ref.base_ref!==n.base_ref)
      add('CRITICAL_HEAD_BASE_STALE_OR_DUPLICATED',[n.pr]);
    unique.add(n.pr);
    if(!n.ci||n.ci.queried_head_sha!==n.head||(typeof n.ci.run_id!=='number'||!Number.isSafeInteger(n.ci.run_id))||
       (n.ci.run_id??0)<=0)
      add('CRITICAL_MAIN_CI_UNKNOWN_OR_STALE',[n.pr]);
    else if(n.ci.status!=='completed'||n.ci.conclusion!=='success')
      add('CRITICAL_MAIN_CI_NOT_GREEN',[n.pr]);
    if(!n.compare||n.compare.head_sha!==n.head||n.compare.base_sha!==n.base||
       n.compare.merge_base!==n.base||n.compare.status!=='ahead')
      add('CRITICAL_MERGE_BASE_NOT_PROVEN',[n.pr]);
    if(!Array.isArray(n.files)||!n.files.length||new Set(n.files).size!==n.files.length||
       n.files.some(p=>!p))
      add('CRITICAL_OWNER_FILE_SCOPE_MISSING',[n.pr]);
  }
  const criticalCollisions:Array<{a:number;b:number;files:string[]}>=[],arr=data.records;
  for(let i=0;i<arr.length;i++)for(let j=i+1;j<arr.length;j++) {
    const a=arr[i]!,b=arr[j]!;
    if(ancestor(a.pr,b.pr)||ancestor(b.pr,a.pr))continue;
    const files=(a.files??[]).filter(path=>(b.files??[]).includes(path)).sort();
    if(files.length)criticalCollisions.push({a:a.pr,b:b.pr,files});
  }
  const criticalByPr=new Map(arr.map(n=>[n.pr,n]));
  const redAncestry=arr.flatMap(n=>{
    const parents=edges.filter(e=>e.child===n.pr).map(e=>e.parent);
    return parents.filter(pr=>{
      const owner=criticalByPr.get(pr);
      return owner&&(owner.ci.status!=='completed'||owner.ci.conclusion!=='success');
    }).map(pr=>({pr:n.pr,parent:pr}));
  });
  if(refs.length!==data.records.length)
    add('FULL_EXACT_CI_FILES_COMPARE_NOT_VERIFIED',refs.filter(x=>!unique.has(x.pr)).map(x=>x.pr));
  if(stale.length)add('STALE_STACKED_PARENT_SHA',stale.map(x=>x.child));
  if(unresolved.length)add('UNRESOLVED_PARENT_REF',unresolved.map(x=>x.pr));
  if(criticalCollisions.length)
    add('INDEPENDENT_OWNER_FILE_COLLISIONS',sorted([...new Set(criticalCollisions.flatMap(x=>[x.a,x.b]))]));
  return {
    gate:'NO_GO' as const,production_merge_authorized:false as const,
    current_safe_merge_queue:[] as never[],main_sha:data.main,
    authoritative_refs_two_pass:paged,
    open_count:refs.length,edge_count:edges.length,stale_parent_count:stale.length,
    stale_parent_edges:stale,unresolved_parents:unresolved,
    detailed_exact_head_count:arr.length,
    missing_detailed_count:Math.max(0,refs.length-unique.size),
    critical_file_collisions:criticalCollisions,critical_red_ancestor_edges:redAncestry,
    critical_ci:arr.map(n=>({pr:n.pr,head:n.head,run:n.ci.run_id,
      status:n.ci.status,conclusion:n.ci.conclusion,compare:n.compare.status})),
    issues,
    full_source_acceptance:false as const,physical_broker_cas_proven:false as const,
    next_step:'Independent #00 full current CI/files/merge-base/owner/ruleset review, native HIGH and off-host CAS proof; do not merge'
  };
}
export function loadLive248Evidence():Evidence {
  const read=(p:string)=>JSON.parse(readFileSync(fileURLToPath(new URL(p,import.meta.url)),'utf8'));
  const root='../docs/qa/fixtures/';
  const census=read(root+'qa24-open-rest-two-pass-20261023.json') as Census;
  const paths=['811-826-845-829','708-726-821-814','831-837-847-850','801-802-835-849'];
  const records=paths.flatMap(p=>(read(root+'qa24-exact-critical-'+p+'.json') as {records:Critical[]}).records);
  return {census,records,main:'754cc4364822be5fda528f54042fb22a84f19924'};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(reviewLive248Evidence(loadLive248Evidence()),null,2)+'\n');
  process.exitCode=2; // Deliberately never authorizes merge.
}
