/** Independent #44 evidence collector. GET-only; NEVER a merge authorizer. */
import {fileURLToPath} from 'node:url';

export type GithubRead = (path:string)=>Promise<unknown>;
type Obj=Record<string,unknown>;
export type PrRef={pr:number;head_sha:string;head_ref:string;base_sha:string;base_ref:string;changed_files:number|null;labels:string[]};
export type Ci={run_id:number;workflow:string;attempt:number;status:string;conclusion:string|null;head_sha:string};
export type NodeEvidence={ref:PrRef;paths:string[];merge_base_sha:string;compare_status:string;ci:Ci[];blockers:string[]};
const SHA=/^[0-9a-f]{40}$/;
const REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const rec=(v:unknown):Obj=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('BAD_REST_OBJECT');return v as Obj;};
const arr=(v:unknown):unknown[]=>{if(!Array.isArray(v))throw Error('BAD_REST_PAGE');return v;};
const str=(v:unknown)=>typeof v==='string'?v:'';
const num=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)?v:-1;
const assertSha=(v:unknown,why:string)=>{const s=str(v);if(!SHA.test(s))throw Error(why);return s;};
const stable=(x:unknown)=>JSON.stringify(x);
const pagePath=(path:string,page:number)=>`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`;

export async function pageArray(api:GithubRead,path:string,max=3000):Promise<unknown[]>{
 const all:unknown[]=[];
 for(let page=1;page<=Math.ceil(max/100)+1;page++){
  const part=arr(await api(pagePath(path,page)));
  if(part.length>100)throw Error('OVERFULL_PAGE');
  all.push(...part);
  if(all.length>max)throw Error('REST_PAGINATION_LIMIT');
  if(part.length<100)return all;
 }
 throw Error('REST_PAGINATION_UNTERMINATED');
}
const readMain=async(api:GithubRead,root:string)=>assertSha(rec(rec(await api(`${root}/git/ref/heads/main`)).object).sha,'MAIN_UNAVAILABLE');
export async function openSnapshot(api:GithubRead,root:string):Promise<PrRef[]>{
 const items=await pageArray(api,`${root}/pulls?state=open`,10000);
 const refs=items.map(raw=>{
  const o=rec(raw),head=rec(o.head),base=rec(o.base);
  if(o.state!=='open')throw Error('NON_OPEN_IN_CENSUS');
  const pr=num(o.number),changed=o.changed_files===undefined?null:num(o.changed_files);
  if(pr<1||(changed!==null&&changed<0))throw Error('BAD_PR_METADATA');
  return {pr,head_sha:assertSha(head.sha,'BAD_HEAD_SHA'),head_ref:str(head.ref),
   base_sha:assertSha(base.sha,'BAD_BASE_SHA'),base_ref:str(base.ref),changed_files:changed,
   labels:arr(o.labels??[]).map(x=>str(rec(x).name)).filter(Boolean).sort()};
 });
 if(refs.some(x=>!x.head_ref||!x.base_ref)||new Set(refs.map(x=>x.pr)).size!==refs.length)
  throw Error('TORN_OR_DUPLICATE_CENSUS');
 return refs.sort((a,b)=>a.pr-b.pr);
}
function ancestorIds(pr:number,byId:Map<number,PrRef>,byBranch:Map<string,number[]>):number[]{
 const found:number[]=[];const seen=new Set([pr]);let cur=byId.get(pr);
 while(cur&&cur.base_ref!=='main'){
  const candidates=byBranch.get(cur.base_ref)||[];
  if(candidates.length!==1)break;
  const parent=candidates[0]!;
  if(seen.has(parent))throw Error('CYCLIC_OPEN_PR_DAG');
  seen.add(parent);found.push(parent);cur=byId.get(parent);
 }
 return found;
}
function workflows(raw:unknown,expected:string):Ci[]{
 const o=rec(raw),items=arr(o.workflow_runs),total=num(o.total_count);
 if(total<0||total!==items.length)throw Error('TORN_ACTIONS_PAGINATION');
 return items.map(x=>{
  const run=rec(x);
  return {run_id:num(run.id),workflow:String(run.workflow_id??run.path??run.name??''),
   attempt:num(run.run_attempt),status:str(run.status),conclusion:run.conclusion===null?null:str(run.conclusion),
   head_sha:str(run.head_sha),event:str(run.event)};
 }).filter(x=>x.head_sha===expected&&x.event==='pull_request')
  .map(({event,...rest})=>rest).sort((a,b)=>a.workflow.localeCompare(b.workflow)||a.run_id-b.run_id);
}
async function readActions(api:GithubRead,root:string,sha:string):Promise<Ci[]>{
 const path=`${root}/actions/runs?head_sha=${sha}`;
 // Fetch all pages, preserving the API total_count on each response.
 const all:unknown[]=[];let total=-1;
 for(let page=1;page<=31;page++){
  const o=rec(await api(pagePath(path,page))),count=num(o.total_count),part=arr(o.workflow_runs);
  if(count<0||part.length>100||(total>=0&&count!==total))throw Error('TORN_ACTIONS_PAGINATION');
  total=count;all.push(...part);
  if(all.length>3000)throw Error('ACTIONS_PAGINATION_LIMIT');
  if(part.length<100){if(all.length!==total)throw Error('TORN_ACTIONS_PAGINATION');
   return workflows({total_count:total,workflow_runs:all},sha);}
 }
 throw Error('ACTIONS_PAGINATION_UNTERMINATED');
}
function ciProblems(ci:Ci[]):string[]{
 const reasons:string[]=[];const latest=new Map<string,Ci>();
 if(!ci.length)return ['MISSING_EXACT_HEAD_PR_CI'];
 const dup=new Set<string>();
 for(const x of ci){
  if(x.run_id<1||x.attempt<1||!x.workflow||!x.status||!SHA.test(x.head_sha))reasons.push('MALFORMED_CI_RUN');
  const k=x.workflow+':'+x.run_id;
  if(dup.has(k))reasons.push('DUPLICATE_CI_RUN');dup.add(k);
  const prev=latest.get(x.workflow);
  if(!prev||x.run_id>prev.run_id||(x.run_id===prev.run_id&&x.attempt>prev.attempt))latest.set(x.workflow,x);
 }
 for(const x of latest.values()){
  if(x.status!=='completed'||x.conclusion!=='success')reasons.push('RED_OR_INCOMPLETE_EXACT_CI');
 }
 const active=new Map<string,number>();
 for(const x of ci)if(x.status!=='completed')active.set(x.workflow,(active.get(x.workflow)||0)+1);
 if([...active.values()].some(n=>n>1))reasons.push('CONCURRENT_WORKFLOW_RUNS');
 if(ci.some(x=>x.attempt>1&&x.status!=='completed'))reasons.push('WORKFLOW_RERUN_IN_PROGRESS');
 return [...new Set(reasons)];
}
async function loadNode(api:GithubRead,root:string,pin:PrRef):Promise<NodeEvidence>{
 const pr=rec(await api(`${root}/pulls/${pin.pr}`)),head=rec(pr.head),base=rec(pr.base);
 if(pr.number!==pin.pr||head.sha!==pin.head_sha||head.ref!==pin.head_ref||
    base.sha!==pin.base_sha||base.ref!==pin.base_ref||pr.state!=='open')throw Error(`PINNED_PR_MOVED_${pin.pr}`);
 const count=num(pr.changed_files);
 if((pin.changed_files!==null&&count!==pin.changed_files)||count<1||count>3000)throw Error(`CHANGED_FILE_COUNT_UNVERIFIABLE_${pin.pr}`);
 const fileObjs=await pageArray(api,`${root}/pulls/${pin.pr}/files`,3000);
 if(fileObjs.length!==count)throw Error(`INCOMPLETE_FILE_PAGINATION_${pin.pr}`);
 const paths:string[]=[];const seenNames=new Set<string>();
 for(const f of fileObjs){const x=rec(f),name=str(x.filename),old=str(x.previous_filename);
  if(!name||[name,old].some(v=>v.startsWith('/')||v.includes('..\\')||v.includes('../')))throw Error(`BAD_CHANGED_PATH_${pin.pr}`);
  if(seenNames.has(name))throw Error(`DUPLICATE_CHANGED_FILENAME_${pin.pr}`);
  seenNames.add(name);paths.push(name);if(old)paths.push(old);
 }
 const unique=[...new Set(paths)].sort();
 if(unique.length===0)throw Error(`NO_CHANGED_FILES_${pin.pr}`);
 const cmp=rec(await api(`${root}/compare/${pin.base_sha}...${pin.head_sha}`));
 const mergeBase=assertSha(rec(cmp.merge_base_commit).sha,`MISSING_MERGE_BASE_${pin.pr}`);
 const ci=await readActions(api,root,pin.head_sha);
 const blockers=[...ciProblems(ci)];
 if(mergeBase!==pin.base_sha||cmp.status!=='ahead')blockers.push('DIVERGED_OR_STALE_MERGE_BASE');
 return {ref:pin,paths:unique,merge_base_sha:mergeBase,compare_status:str(cmp.status),ci,blockers};
}
export async function collectOpenPrIntegration(api:GithubRead,repo:string,explicitCritical:number[]){
 if(!REPO.test(repo)||!Array.isArray(explicitCritical)||explicitCritical.some(n=>!Number.isSafeInteger(n)||n<1))throw Error('BAD_COLLECTOR_INPUT');
 const root=`/repos/${repo}`,mainBefore=await readMain(api,root);
 const before=await openSnapshot(api,root);
 const byId=new Map(before.map(x=>[x.pr,x]));
 const byBranch=new Map<string,number[]>();for(const p of before)byBranch.set(p.head_ref,[...(byBranch.get(p.head_ref)||[]),p.pr]);
 const criticalIds=new Set<number>([...explicitCritical,...before.filter(p=>p.labels.some(l=>/^(p0|p1|priority[:/ -]?(0|1))$/i.test(l))).map(p=>p.pr)]);
 for(const id of [...criticalIds]){
  if(!byId.has(id))throw Error(`CRITICAL_NOT_OPEN_${id}`);
  for(const ancestor of ancestorIds(id,byId,byBranch))criticalIds.add(ancestor);
 }
 if(criticalIds.size===0)throw Error('CRITICAL_SCOPE_REQUIRED');
 const evidence:NodeEvidence[]=[];
 for(const id of [...criticalIds].sort((a,b)=>a-b))evidence.push(await loadNode(api,root,byId.get(id)!));
 const after=await openSnapshot(api,root),mainAfter=await readMain(api,root);
 if(mainBefore!==mainAfter||stable(before)!==stable(after))throw Error('TORN_OPEN_PR_CENSUS');
 const blockers:{pr:number;reason:string;related_pr?:number;file?:string}[]=[];
 const byEvidence=new Map(evidence.map(n=>[n.ref.pr,n]));
 for(const n of evidence){
  const p=n.ref;
  for(const reason of n.blockers)blockers.push({pr:p.pr,reason});
  if(p.base_ref==='main'){if(p.base_sha!==mainBefore)blockers.push({pr:p.pr,reason:'STALE_MAIN_BASE_SHA'});}
  else{
   const ps=byBranch.get(p.base_ref)||[];
   if(ps.length!==1)blockers.push({pr:p.pr,reason:'UNRESOLVED_OR_AMBIGUOUS_PARENT'});
   else{
    const parent=byId.get(ps[0]!)!;
    if(parent.head_sha!==p.base_sha)blockers.push({pr:p.pr,related_pr:parent.pr,reason:'STALE_PARENT_SHA'});
    const parentNode=byEvidence.get(parent.pr);
    if(!parentNode||parentNode.blockers.length)blockers.push({pr:p.pr,related_pr:parent.pr,reason:'RED_OR_UNKNOWN_ANCESTOR'});
   }
  }
  for(const parentId of ancestorIds(p.pr,byId,byBranch)){
   const parent=byEvidence.get(parentId);
   if(!parent||parent.blockers.length)blockers.push({pr:p.pr,related_pr:parentId,reason:'RED_OR_UNKNOWN_ANCESTOR'});
  }
 }
 // Independent branches only. Stack parent/child overlaps are not cross-owner collisions.
 for(let i=0;i<evidence.length;i++)for(let j=i+1;j<evidence.length;j++){
  const a=evidence[i]!,b=evidence[j]!;
  if(ancestorIds(a.ref.pr,byId,byBranch).includes(b.ref.pr)||
     ancestorIds(b.ref.pr,byId,byBranch).includes(a.ref.pr))continue;
  const left=new Set(a.paths);
  for(const f of b.paths)if(left.has(f))blockers.push({pr:a.ref.pr,related_pr:b.ref.pr,reason:'INDEPENDENT_FILE_COLLISION',file:f});
 }
 // Recheck CI after census: an in-flight run or manual rerun must invalidate initial evidence.
 for(const n of evidence){
  const current=await readActions(api,root,n.ref.head_sha);
  if(stable(current)!==stable(n.ci))blockers.push({pr:n.ref.pr,reason:'CI_CHANGED_DURING_COLLECTION'});
 }
 return {gate:'NO_GO' as const,production_merge_authorized:false as const,
  safe_merge_queue:[] as number[],main_sha:mainBefore,open_count:before.length,
  open_refs_double_read:true,critical_scope_complete_for_selected:true,
  all_open_detailed_ci_verified:evidence.length===before.length,
  critical_ids:[...criticalIds].sort((a,b)=>a-b),
  evidence,blockers,limitations:['NO_HUMAN_00_MERGE_AUTHORITY','SOURCE_CI_IS_NOT_PHYSICAL_ACCEPTANCE',
   'CRITICAL_SCOPE_REQUIRES_00_REVIEW','DOUBLE_PASS_CANNOT_PROVE_ATOMIC_SERVER_SNAPSHOT']};
}
export function githubRead(token:string):GithubRead{
 if(!token)throw Error('GITHUB_TOKEN_REQUIRED');
 return async path=>{
  if(!/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\//.test(path))throw Error('API_SCOPE_DENIED');
  const response=await fetch('https://api.github.com'+path,{
   method:'GET',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20000),
   headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json',
    'X-GitHub-Api-Version':'2022-11-28','User-Agent':'nexowire-qa44-readonly'}});
  if(!response.ok)throw Error(`GITHUB_GET_${response.status}`);
  return response.json();
 };
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const repo=process.argv[2]||'';
 const critical=(process.argv[3]||'').split(',').filter(Boolean).map(Number);
 Promise.resolve().then(()=>collectOpenPrIntegration(githubRead(process.env.GH_TOKEN||process.env.GITHUB_TOKEN||''),repo,critical))
  .then(out=>{process.stdout.write(JSON.stringify(out,null,2)+'\n');process.exitCode=2;})
  .catch(e=>{process.stdout.write(JSON.stringify({gate:'NO_GO',safe_merge_queue:[],
   production_merge_authorized:false,error:e instanceof Error?e.message:'UNKNOWN'})+'\n');process.exitCode=3;});
}
