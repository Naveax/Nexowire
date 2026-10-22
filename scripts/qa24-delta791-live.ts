/**
 * QA24 read-only incremental REST collector. All open refs are paginated and
 * double-read, but detailed file/CI/compare fetches are only for 791–803,
 * plus cross-owner red 708/726. This does NOT certify all open PRs merge-safe.
 */
import {fileURLToPath} from 'node:url';
import {githubRestRead,parseExactCi} from './qa24-live-dag.js';
import {readAllOpenRefs} from './qa24-delta781-live.js';
import type {GithubRead} from './qa24-live-dag.js';
import type {Pr} from './qa24-partitioned-dag-review.js';

const sha=/^[0-9a-f]{40}$/;
const rec=(x:unknown):Record<string,unknown>=>{
 if(!x||typeof x!=='object'||Array.isArray(x))throw Error('BAD_REST_OBJECT');
 return x as Record<string,unknown>;
};
const list=(x:unknown):unknown[]=>{
 if(!Array.isArray(x))throw Error('BAD_REST_PAGE');
 return x;
};
const st=(x:unknown)=>typeof x==='string'?x:'';
const targets=[708,726,...Array.from({length:13},(_,i)=>791+i)];
export async function collect791803Live(api:GithubRead,repo:string) {
 if(!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo))throw Error('BAD_REPO');
 const prefix='/repos/'+repo;
 const main=async()=>st(rec(rec(await api(prefix+'/branches/main')).commit).sha);
 const mainBefore=await main();
 if(!sha.test(mainBefore))throw Error('MAIN_UNAVAILABLE');
 const before=await readAllOpenRefs(api,repo);
 if(targets.some(pr=>!before.some(n=>n.pr===pr)))
   throw Error('TARGET_PR_NOT_OPEN');
 const nodes:Pr[]=[];
 for(const pr of targets) {
   const pinned=before.find(x=>x.pr===pr)!;
   const files:string[]=[];let ended=false;
   for(let page=1;page<=31;page++){
     const part=list(await api(`${prefix}/pulls/${pr}/files?per_page=100&page=${page}`))
       .map(f=>st(rec(f).filename));
     if(part.some(x=>!x)||new Set(part).size!==part.length)
       throw Error('FILE_PAGE_BAD_'+pr);
     files.push(...part);
     if(part.length<100){ended=true;break;}
   }
   if(!ended||files.length===0||new Set(files).size!==files.length)
     throw Error('INCOMPLETE_CHANGED_FILES_'+pr);
   const run=parseExactCi(pinned.head_sha,
     await api(`${prefix}/actions/runs?head_sha=${pinned.head_sha}&per_page=100`));
   const compare=rec(await api(`${prefix}/compare/${pinned.base_sha}...${pinned.head_sha}`));
   const merge=st(rec(compare.merge_base_commit).sha),status=st(compare.status);
   if(!sha.test(merge)||!status)throw Error('MISSING_COMPARE_'+pr);
   nodes.push({...pinned,files,files_complete:true,
     compare:{base_sha:pinned.base_sha,head_sha:pinned.head_sha,
       merge_base_sha:merge,status},
     ci:{run_id:run.run_id,status:run.workflow_status??'unknown',
       conclusion:run.conclusion,queried_head_sha:pinned.head_sha}});
 }
 const after=await readAllOpenRefs(api,repo);
 if(JSON.stringify(before)!==JSON.stringify(after)||mainBefore!==await main())
   throw Error('TORN_OPEN_PR_HEAD_OR_MAIN');
 return {gate:'NO_GO' as const,source:'GET_ONLY_GITHUB_REST',
   open_count_at_double_read:before.length,all_open_refs_double_read:true,
   all_open_ci_and_files_verified:false,
   targets,delta:nodes,
   blocked:nodes.filter(n=>n.ci.conclusion!=='success'||
      n.compare?.merge_base_sha!==n.base_sha||n.compare?.status!=='ahead')
     .map(n=>({pr:n.pr,ci:n.ci.conclusion??n.ci.status,
       compare:n.compare?.status})),
   current_safe_merge_candidates:[] as never[],
   production_merge_authorized:false as const};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const repo=process.argv[2]??'';
 const token=process.env.GH_TOKEN||process.env.GITHUB_TOKEN||'';
 collect791803Live(githubRestRead(token),repo).then(r=>{
   process.stdout.write(JSON.stringify(r,null,2)+'\n');process.exitCode=2;
 }).catch(e=>{process.stderr.write('QA24_FAIL_CLOSED:'+
   (e instanceof Error?e.message:'UNKNOWN')+'\n');process.exitCode=3;});
}
