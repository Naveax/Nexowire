/**
 * QA24 NEXT2: exhaustive two-pass GET-only GitHub verification.
 * Invokes existing #24 full source collector twice; no GitHub writes or CI reruns.
 * Even 100% green source evidence cannot authorize physical P0 acceptance.
 */
import {fileURLToPath} from 'node:url';
import {collectLiveSnapshot,auditLiveSnapshot,githubRestRead} from './qa24-live-dag.js';
import type {GithubRead,LiveSnapshot} from './qa24-live-dag.js';

const critical=[708,726,786,800,801,802,810,811,814,821,826,831,837];
const fingerprint=(s:LiveSnapshot)=>JSON.stringify({
 main:s.main_head,
 nodes:s.nodes.map(n=>({
  pr:n.pr,head_sha:n.head_sha,base_sha:n.base_sha,
  head_ref:n.head_ref,base_ref:n.base_ref,parent_pr:n.parent_pr,
  files:n.files,files_complete:n.files_complete,ci:n.ci,
  merge_base_sha:n.merge_base_sha,compare_status:n.compare_status
 }))
});

export function adjudicateNext2(a:LiveSnapshot,b:LiveSnapshot) {
 if(!a.open_prs_complete||!b.open_prs_complete||a.errors.length||b.errors.length)
  throw Error('INCOMPLETE_FULL_PR_CENSUS');
 if(fingerprint(a)!==fingerprint(b))
  throw Error('TWO_PASS_HEAD_BASE_FILES_CI_MERGE_BASE_MOVED');
 const by=new Map(b.nodes.map(n=>[n.pr,n]));
 const missing=critical.filter(n=>!by.has(n));
 if(missing.length)throw Error('CRITICAL_PR_NOT_OPEN_'+missing.join('_'));
 const audit=auditLiveSnapshot(a,b);
 const row=(id:number)=>by.get(id)!;
 const blockers:{pr:number;reason:string;related?:number}[]=[];
 const deny=(pr:number,reason:string,related?:number)=>
  blockers.push({pr,reason,...(related==null?{}:{related})});
 for(const n of b.nodes){
  if(n.ci.run_head_sha!==n.head_sha||n.ci.status!=='success')
   deny(n.pr,'EXACT_HEAD_CI_NOT_GREEN');
  if(!n.files_complete||!n.files.length)deny(n.pr,'FILES_UNVERIFIED');
  if(n.merge_base_sha!==n.base_sha||n.compare_status!=='ahead')
   deny(n.pr,'DIVERGED_OR_UNKNOWN_COMPARE');
  if(n.base_ref!=='main'){
   const p=by.get(n.parent_pr??-1);
   if(!p)deny(n.pr,'MISSING_OPEN_PARENT');
   else {
    if(n.base_sha!==p.head_sha)deny(n.pr,'STALE_PARENT_SHA',p.pr);
    if(p.ci.status!=='success')deny(n.pr,'RED_PARENT',p.pr);
   }
  } else if(n.base_sha!==b.main_head)deny(n.pr,'STALE_MAIN_SHA');
 }
 // Independent hostile tests remain separately red even when the Git executor is green.
 const git=row(811),children=[row(814),row(821)];
 for(const child of children){
  if(child.base_sha!==git.head_sha)deny(child.pr,'GIT_TEST_BASE_NOT_CURRENT_811',811);
  if(child.ci.status!=='success')deny(811,'HOSTILE_CHILD_RED',child.pr);
 }
 const workflowIds=[801,802,837];
 for(let i=0;i<workflowIds.length;i++)for(let j=i+1;j<workflowIds.length;j++){
  const l=row(workflowIds[i]!),r=row(workflowIds[j]!);
  if(l.files.includes('.github/workflows/ci.yml')&&r.files.includes('.github/workflows/ci.yml'))
   deny(l.pr,'INDEPENDENT_WORKFLOW_OWNER_COLLISION',r.pr);
 }
 // This is an independent confirmation, not pretending source CI accepts native authority.
 if(row(708).compare_status==='diverged')deny(708,'CROSS_HUB_DIVERGED');
 if(row(726).ci.status!=='success')deny(726,'CORE_NATIVE_UI_RED');
 for(const id of [826,837])if(row(id).ci.status!=='success')deny(id,'P0_ACCEPTANCE_RED');
 return {
   gate:'NO_GO' as const,physical_acceptance:'NOT_PROVEN' as const,
   production_merge_authorized:false as const,safe_merge_queue:[] as number[],
   full_two_pass_details_verified:true as const,
   repository:b.repository,main_sha:b.main_head,open_count:b.open_pr_count,
   exact_critical:critical.map(id=>{const n=row(id);return {
     pr:id,head_sha:n.head_sha,base_sha:n.base_sha,
     parent_pr:n.parent_pr,ci_run:n.ci.run_id,
     ci_status:n.ci.status,ci_conclusion:n.ci.conclusion,
     compare:n.compare_status,changed_files:n.files.length
   }}),
   risk_count:audit.risk_count,
   critical_blockers:blockers.filter(z=>critical.includes(z.pr)),
   cross_owner_collisions:audit.findings.filter(x=>x.code==='OWNER_COLLISION').length,
   differing_test_parent_sha:children.map(n=>({pr:n.pr,base_sha:n.base_sha,
     expected_811_sha:git.head_sha,sha_matches:n.base_sha===git.head_sha})),
   source_success_is_not_native_acceptance:true as const,
   note:'No main mutation or runtime Agent/UAC/VM. #00 approves nothing from a source-only CI run.'
 };
}
export async function collectNext2DoublePass(api:GithubRead,repo:string){
 const first=await collectLiveSnapshot(api,repo,'FIRST_PASS');
 const second=await collectLiveSnapshot(api,repo,'SECOND_PASS');
 return adjudicateNext2(first,second);
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const repo=process.argv[2]||'';
 const token=process.env.GH_TOKEN||process.env.GITHUB_TOKEN||'';
 collectNext2DoublePass(githubRestRead(token),repo).then(result=>{
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  process.exitCode=2; // Deliberate NO_GO even if every source job is green.
 }).catch(e=>{
  process.stderr.write('QA24_NEXT2_FAIL_CLOSED:'+
   (e instanceof Error?e.message:'UNKNOWN')+'\n');process.exitCode=3;
 });
}
