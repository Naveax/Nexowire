/**
 * QA24 full REST-only snapshot + explicit non-authorizing release gate.
 * Reuses the existing collector that pages every open PR, downloads EVERY
 * changed-file list, exact HEAD CI and merge-base, then double-reads refs/main.
 * No POST/PATCH, CI reruns, or merge path. Never prints credentials.
 */
import {fileURLToPath} from 'node:url';
import {collectLiveSnapshot,githubRestRead,type GithubRead,type LiveSnapshot}
  from './qa24-live-dag.js';

type Blocker={code:string;prs:number[];detail:string};
const SHA=/^[a-f0-9]{40}$/;
const physical=['INDEPENDENT_EXTERNAL_ATOMIC_CAS_WITNESS',
  'SIGNED_HIGH_BROKER_NATIVE_OS_TOKEN_AND_ACL',
  'SIGNED_FINAL_ARTIFACT_WRITER_STOP_REVOKE',
  'PHYSICAL_WINDOWS_AND_TWO_HUB_ACCEPTANCE'] as const;
const keyPaths=['.github/workflows/ci.yml',
  'test/p20-780-git-fsmonitor-hook-escape-negative.test.ts',
  'test/p26-780-git-worktree-root-escape-negative.test.ts'];

export function qa24ReleaseGate(snapshot:LiveSnapshot,expectedOpenIds?:number[]) {
 const issues:Blocker[]=[];
 const add=(code:string,prs:number[],detail:string)=>issues.push({code,prs,detail});
 const by=new Map<number,LiveSnapshot['nodes'][number]>();
 const refs=new Map<string,number>();
 if(!snapshot.open_prs_complete||snapshot.errors.length||
   snapshot.nodes.length!==snapshot.open_pr_count||
   !SHA.test(snapshot.main_head))
   add('FULL_SNAPSHOT_NOT_VERIFIED',[], 'Missing, torn or invalid open-source snapshot');
 for(const n of snapshot.nodes){
   if(by.has(n.pr)||refs.has(n.head_ref)||!SHA.test(n.head_sha)||!SHA.test(n.base_sha))
     add('DUPLICATE_OR_BAD_HEAD',[n.pr],'PR/ref/SHA collision');
   by.set(n.pr,n);refs.set(n.head_ref,n.pr);
   if(!n.files_complete||!n.files.length||new Set(n.files).size!==n.files.length)
     add('INCOMPLETE_OWNER_FILES',[n.pr],'Cannot prove absent file collisions');
   if(!n.ci.run_id||n.ci.run_head_sha!==n.head_sha)
     add('MISSING_EXACT_HEAD_PRIMARY_CI',[n.pr],'Unknown must remain UNKNOWN');
   if(n.ci.status!=='success')
     add('NON_GREEN_PRIMARY_CI',[n.pr],n.ci.status);
   if(!n.merge_base_sha||n.compare_status!=='ahead'||n.merge_base_sha!==n.base_sha)
     add('MERGE_BASE_STALE_OR_DIVERGED',[n.pr],n.compare_status??'UNKNOWN');
   if(n.base_ref==='main'&&n.base_sha!==snapshot.main_head)
     add('STALE_MAIN_BASE',[n.pr],n.base_sha);
 }
 if(expectedOpenIds){
   const current=[...by.keys()].sort((a,b)=>a-b),expected=[...expectedOpenIds].sort((a,b)=>a-b);
   if(JSON.stringify(current)!==JSON.stringify(expected))
     add('OBSERVED_OPEN_ID_DRIFT',[],
       'Historical count/IDs changed. A source-green branch is not merge-safe.');
 }
 const parent=new Map<number,number|null>();
 for(const n of snapshot.nodes){
   const p=n.base_ref==='main'?null:refs.get(n.base_ref)??null;
   parent.set(n.pr,p);
   if(n.base_ref!=='main'&&p===null)add('UNRESOLVED_PARENT',[n.pr],n.base_ref);
   if(p!==null) {
     const ancestor=by.get(p);
     if(!ancestor||ancestor.head_sha!==n.base_sha)
       add('STALE_PARENT_HEAD',[n.pr,p],n.base_sha);
     if(ancestor?.ci.status!=='success')
       add('RED_OR_UNKNOWN_DIRECT_PARENT',[n.pr,p],ancestor?.ci.status??'UNKNOWN');
   }
 }
 const ancestors=(pr:number)=>{
   const chain:number[]=[],seen=new Set<number>([pr]);
   let p=parent.get(pr);
   while(p!=null) {
     if(seen.has(p)){add('DEPENDENCY_CYCLE',[pr,p],'Cyclic stack');break;}
     seen.add(p);chain.push(p);p=parent.get(p);
   }
   return chain;
 };
 const chains=new Map(snapshot.nodes.map(n=>[n.pr,ancestors(n.pr)]));
 for(const [pr,chain] of chains) if(chain.some(p=>{
   const x=by.get(p);
   return !x||x.ci.status!=='success'||x.ci.run_head_sha!==x.head_sha||
     x.compare_status!=='ahead'||x.merge_base_sha!==x.base_sha;
 }))add('RED_STALE_OR_UNKNOWN_ANCESTOR',[pr],chain.join(' <- '));
 const pathMap=new Map<string,number[]>();
 for(const n of snapshot.nodes)for(const p of new Set(n.files)){
   const group=pathMap.get(p)??[];group.push(n.pr);pathMap.set(p,group);
 }
 const ownerCollisions:Array<{a:number;b:number;file:string}>=[];
 for(const [file,prs] of pathMap) for(let i=0;i<prs.length;i++)
   for(let j=i+1;j<prs.length;j++) {
     const a=prs[i]!,b=prs[j]!;
     if(chains.get(a)?.includes(b)||chains.get(b)?.includes(a))continue;
     ownerCollisions.push({a,b,file});
   }
 for(const n of [708,726,786,800,801,802,811]){
   if(!by.has(n))add('CRITICAL_OWNER_PR_MISSING',[n],'No current HEAD witness');
 }
 for(const [a,b,filename] of [
   [811,786,keyPaths[2]!],[811,800,keyPaths[1]!],[801,802,keyPaths[0]!] ] as const) {
   if(by.get(a)?.files.includes(filename)&&by.get(b)?.files.includes(filename))
     add('MATERIAL_OWNER_PATH_OVERLAP',[a,b],filename);
   else add('OWNER_PATH_WITNESS_MOVED_OR_MISSING',[a,b],filename);
 }
 const coreGit=by.get(811);
 if(coreGit?.ci.status==='success')
   add('SOURCE_GREEN_NOT_ORIGINAL_NEGATIVE_PROOF',[811,786,800],
     'Original #786/#800 byte-identical tests not independently rerun against #811 source');
 for(const [k,condition] of [
   ['TWO_HUB_CAS',false],['HIGH_BROKER',false],
   ['SIGNED_FINAL_PUBLISHER',false],['PHYSICAL_ACCEPTANCE',false]
 ] as const) if(!condition) add('PHYSICAL_RELEASE_WITNESS_MISSING',[],k);
 issues.sort((a,b)=>a.code.localeCompare(b.code)||((a.prs[0]??0)-(b.prs[0]??0)));
 return {
   gate:'NO_GO' as const,production_merge_authorized:false as const,
   source_review_is_not_release_authority:true as const,
   current_safe_merge_queue:[] as never[],
   pr_count:snapshot.nodes.length,exact_ci_green:snapshot.nodes.filter(n=>n.ci.status==='success').length,
   exact_ci_failure:snapshot.nodes.filter(n=>n.ci.status==='failure').length,
   exact_ci_pending_unknown:snapshot.nodes.filter(n=>!['success','failure'].includes(n.ci.status)).length,
   dependency_edges:[...parent.values()].filter(p=>p!==null).length,
   independent_owner_collisions:ownerCollisions.length,
   critical_collisions:ownerCollisions.filter(x=>keyPaths.includes(x.file)),
   physical_release_witnesses_required:[...physical],
   issues
 };
}
export async function collectQa24FullReview(api:GithubRead,repo:string) {
 // TWO full rounds, not merely two reads of the open PR list. Every round
 // fetches HEAD/base, all files, SHA-bound CI and Git merge-base for every PR.
 // A changed run/conclusion or path set without HEAD movement is still torn.
 const first=await collectLiveSnapshot(api,repo);
 const source=await collectLiveSnapshot(api,repo);
 const stable=(s:LiveSnapshot)=>JSON.stringify({
   main:s.main_head,ids:s.nodes.map(n=>n.pr),
   nodes:s.nodes.map(n=>({
     pr:n.pr,head:n.head_sha,base:n.base_sha,base_ref:n.base_ref,
     head_ref:n.head_ref,files:n.files.slice().sort(),
     ci_run:n.ci.run_id,ci_head:n.ci.run_head_sha,ci_status:n.ci.status,
     ci_workflow_status:n.ci.workflow_status,ci_conclusion:n.ci.conclusion,
     merge:n.merge_base_sha,compare:n.compare_status
   }))
 });
 if(stable(first)!==stable(source))
   throw new Error('FULL_SOURCE_CI_FILES_COMPARE_MOVED_BETWEEN_PASSES');
 const review=qa24ReleaseGate(source);
 return {source,review,full_source_passes:2 as const};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const repo=process.argv[2]??'';
 const token=process.env.GH_TOKEN||process.env.GITHUB_TOKEN||'';
 collectQa24FullReview(githubRestRead(token),repo).then(r=>{
   process.stdout.write(JSON.stringify(r,null,2)+'\n');
   process.exitCode=2; // A source snapshot, even green, is NEVER P0 release.
 }).catch(e=>{
   process.stderr.write('QA24_FAIL_CLOSED:'+(e instanceof Error?e.message:'UNKNOWN')+'\n');
   process.exitCode=3;
 });
}
