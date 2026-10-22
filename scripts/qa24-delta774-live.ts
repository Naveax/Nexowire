/**
 * QA24 read-only LIVE updater: partition search (paged), then PR 774-779 ONLY.
 * No repository writes, reruns, merges, tokens printed, owner implementation edits.
 * Prior 173 heads are NOT refreshed, so this NEVER proves complete merge safety.
 */
import {fileURLToPath} from 'node:url';
import {GithubRead,githubRestRead,parseExactCi} from './qa24-live-dag.js';
import type {Pr,Census} from './qa24-partitioned-dag-review.js';

const sha=/^[0-9a-f]{40}$/;
const filters=[
 'created:<2026-10-21',
 'created:2026-10-21T00:00:00Z..2026-10-21T17:59:59Z',
 'created:2026-10-21T18:00:00Z..2026-10-21T23:59:59Z',
 'created:>=2026-10-22'
] as const;
const record=(x:unknown):Record<string,any>=>{
 if(!x||typeof x!=='object'||Array.isArray(x))throw new Error('INVALID_GITHUB_OBJECT');
 return x as Record<string,any>;
};
const list=(x:unknown):unknown[]=>{
 if(!Array.isArray(x))throw new Error('INVALID_GITHUB_ARRAY');
 return x;
};
const int=(x:unknown)=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0?x:-1;
const str=(x:unknown)=>typeof x==='string'?x:'';
const safeRepo=(repo:string)=>repo.split('/').length===2&&
  repo.split('/').every(n=>/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(n)&&!n.includes('..'));
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);

export async function partitionedOpenCensus(api:GithubRead,repo:string,
  windows:readonly string[]=filters):Promise<Census> {
  if(!safeRepo(repo)||windows.length===0)throw new Error('INVALID_REPO_OR_PARTITION');
  const segments:Array<{query:string;ids:number[]}>=[],global=new Set<number>();
  for(const filter of windows) {
    const query=`repo:${repo} is:pr is:open ${filter}`;
    const ids:number[]=[];let total=-1;
    for(let page=1;page<=10;page++){
      const uri=`/search/issues?q=${encodeURIComponent(query)}&per_page=100&page=${page}`;
      const response=record(await api(uri));
      const count=int(response.total_count),items=list(response.items);
      if(count<0||count>950||items.length>100)throw new Error('TRUNCATED_OR_INVALID_SEARCH');
      if(total<0)total=count;
      if(total!==count)throw new Error('MOVING_PARTITION_COUNT');
      for(const entry of items){
        const item=record(entry),pr=int(item.number);
        if(pr<=0||!item.pull_request||global.has(pr))
          throw new Error('DUPLICATE_OR_INVALID_PULL_RESULT');
        global.add(pr);ids.push(pr);
      }
      if(ids.length===total)break;
      if(items.length!==100||page===10)throw new Error('PARTITION_PAGE_INCOMPLETE');
    }
    if(ids.length!==total)throw new Error('PARTITION_TOTAL_MISMATCH');
    segments.push({query,ids});
  }
  const ids=[...global].sort((a,b)=>a-b);
  if(ids.length===0)throw new Error('EMPTY_OPEN_PR_CENSUS');
  return {ids,segments};
}

export async function collect774779(api:GithubRead,repo:string) {
  if(!safeRepo(repo))throw new Error('INVALID_REPO');
  const pre='/repos/'+repo;
  const main=async()=>{
    const b=record(await api(pre+'/branches/main'));
    return str(record(b.commit).sha);
  };
  const mainBefore=await main();
  if(!sha.test(mainBefore))throw new Error('MAIN_SHA_MISSING');
  const census=await partitionedOpenCensus(api,repo);
  const targets=[774,775,776,777,778,779];
  if(targets.some(n=>!census.ids.includes(n)))throw new Error('EXPECTED_PR_CLOSED_OR_MISSING');
  const nodes:Pr[]=[];
  const rawRefs:Array<[number,string,string,string,string]>=[];
  for(const pr of targets) {
    const raw=record(await api(`${pre}/pulls/${pr}`));
    const head=record(raw.head),base=record(raw.base);
    const head_sha=str(head.sha),base_sha=str(base.sha);
    const head_ref=str(head.ref),base_ref=str(base.ref);
    if(int(raw.number)!==pr||raw.state!=='open'||
       !sha.test(head_sha)||!sha.test(base_sha)||!head_ref||!base_ref)
      throw new Error(`INVALID_PR_EXACT_REF_${pr}`);
    rawRefs.push([pr,head_sha,base_sha,head_ref,base_ref]);
    const files:string[]=[];
    for(let page=1;page<=31;page++){
      const chunk=list(await api(`${pre}/pulls/${pr}/files?per_page=100&page=${page}`))
        .map(a=>str(record(a).filename));
      if(chunk.some(x=>!x)||new Set(chunk).size!==chunk.length)
        throw new Error(`BAD_CHANGED_FILES_${pr}`);
      files.push(...chunk);
      if(chunk.length<100)break;
      if(page===31)throw new Error(`FILE_PAGINATION_OVERFLOW_${pr}`);
    }
    if(!files.length||new Set(files).size!==files.length)
      throw new Error(`INCOMPLETE_CHANGED_FILES_${pr}`);
    const runs=await api(`${pre}/actions/runs?head_sha=${head_sha}&per_page=100`);
    const ci=parseExactCi(head_sha,runs);
    const comparison=record(await api(`${pre}/compare/${base_sha}...${head_sha}`));
    const merge_sha=str(record(comparison.merge_base_commit).sha);
    if(!sha.test(merge_sha)||!str(comparison.status))
      throw new Error(`INVALID_COMPARE_${pr}`);
    nodes.push({pr,head_sha,head_ref,base_sha,base_ref,files,files_complete:true,
      compare:{base_sha,head_sha,merge_base_sha:merge_sha,status:str(comparison.status)},
      ci:{run_id:ci.run_id,status:ci.workflow_status??'unknown',
        conclusion:ci.conclusion,queried_head_sha:head_sha}});
  }
  const censusAfter=await partitionedOpenCensus(api,repo);
  if(!same(census.ids,censusAfter.ids))throw new Error('OPEN_SET_MOVED_DURING_CAPTURE');
  for(const [pr,h,b,href,bref] of rawRefs) {
    const p=record(await api(`${pre}/pulls/${pr}`));
    const h2=record(p.head),b2=record(p.base);
    if(str(h2.sha)!==h||str(b2.sha)!==b||str(h2.ref)!==href||
      str(b2.ref)!==bref||p.state!=='open')
      throw new Error(`PR_HEAD_MOVED_DURING_CAPTURE_${pr}`);
  }
  if(await main()!==mainBefore)throw new Error('MAIN_MOVED_DURING_CAPTURE');
  return {gate:'NO_GO' as const,main_head:mainBefore,
    source:'github-api-read-only',census,nodes,targets_only:targets,
    other_pr_heads_revalidated:false,production_merge_authorized:false};
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  const repo=process.argv[2];
  if(!repo)throw new Error('USAGE: node --import tsx scripts/qa24-delta774-live.ts Naveax/Nexowire');
  const token=process.env.GH_TOKEN||process.env.GITHUB_TOKEN||'';
  collect774779(githubRestRead(token),repo).then(x=>{
    process.stdout.write(JSON.stringify(x,null,2)+'\n');
    process.exitCode=2; // No merge permission, even after passing capture.
  }).catch(e=>{
    process.stderr.write('QA24_FAIL_CLOSED:'+String(e instanceof Error?e.message:'UNKNOWN')+'\n');
    process.exitCode=3;
  });
}
