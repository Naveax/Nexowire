/**
 * #24 authoritative GET /pulls pagination. Fetch only PRs #781–#790 in detail.
 * Double reads EVERY open PR ID/head/base, never merges or calls POST.
 */
import {fileURLToPath} from 'node:url';
import {githubRestRead,parseExactCi} from './qa24-live-dag.js';
import type {GithubRead} from './qa24-live-dag.js';
import type {Pr} from './qa24-partitioned-dag-review.js';

const sha=/^[a-f0-9]{40}$/;
const validRepo=(x:string)=>x.split('/').length===2&&x.split('/').every(
  p=>/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(p)&&!p.includes('..'));
const obj=(x:unknown):Record<string,unknown>=>{
  if(!x||typeof x!=='object'||Array.isArray(x))throw new Error('BAD_GITHUB_OBJECT');
  return x as Record<string,unknown>;
};
const arr=(x:unknown):unknown[]=>{
  if(!Array.isArray(x))throw new Error('BAD_GITHUB_LIST');
  return x;
};
const s=(x:unknown)=>typeof x==='string'?x:'';
const num=(x:unknown)=>typeof x==='number'&&Number.isSafeInteger(x)?x:0;
type Ref={pr:number;head_sha:string;base_sha:string;head_ref:string;base_ref:string};

export async function readAllOpenRefs(api:GithubRead,repo:string) {
  if(!validRepo(repo))throw new Error('BAD_REPOSITORY');
  const rows:Ref[]=[];const seen=new Set<number>(),branches=new Set<string>();
  let sawShort=false;
  for(let page=1;page<=11;page++){
    const items=arr(await api(`/repos/${repo}/pulls?state=open&per_page=100&page=${page}`));
    if(items.length>100)throw new Error('INVALID_PAGE_SIZE');
    if(sawShort&&items.length)throw new Error('NONTERMINAL_SHORT_PAGE');
    for(const item of items) {
      const x=obj(item),h=obj(x.head),b=obj(x.base),pr=num(x.number);
      const head_sha=s(h.sha),base_sha=s(b.sha);
      const head_ref=s(h.ref),base_ref=s(b.ref);
      if(pr<=0||x.state!=='open'||!sha.test(head_sha)||!sha.test(base_sha)||
         !head_ref||!base_ref||seen.has(pr)||branches.has(head_ref))
        throw new Error('DUPLICATE_OR_BAD_OPEN_PR');
      seen.add(pr);branches.add(head_ref);
      rows.push({pr,head_sha,base_sha,head_ref,base_ref});
    }
    if(items.length===0) {
      if(!rows.length)throw new Error('EMPTY_OPEN_PR_LIST');
      return rows.sort((a,b)=>a.pr-b.pr);
    }
    if(items.length<100)sawShort=true;
    if(page===11)throw new Error('OPEN_PR_PAGE_LIMIT');
  }
  throw new Error('OPEN_PR_NO_TERMINATOR');
}

export async function collect781790Live(api:GithubRead,repo:string) {
  if(!validRepo(repo))throw new Error('BAD_REPOSITORY');
  const prefix=`/repos/${repo}`;
  const main=async()=>s(obj(obj(await api(prefix+'/branches/main')).commit).sha);
  const mainBefore=await main();
  if(!sha.test(mainBefore))throw new Error('MAIN_SHA_UNKNOWN');
  const before=await readAllOpenRefs(api,repo);
  const targetIds=Array.from({length:10},(_,i)=>781+i);
  if(targetIds.some(n=>!before.some(r=>r.pr===n)))
    throw new Error('DELTA_NOT_ALL_OPEN');
  const nodes:Pr[]=[];
  for(const pr of targetIds) {
    const pinned=before.find(x=>x.pr===pr)!;
    const files:string[]=[];
    let done=false;
    for(let page=1;page<=31;page++){
      const chunk=arr(await api(`${prefix}/pulls/${pr}/files?per_page=100&page=${page}`))
        .map(x=>s(obj(x).filename));
      if(chunk.some(f=>!f)||new Set(chunk).size!==chunk.length)
        throw new Error(`BAD_FILE_PAGE_${pr}`);
      files.push(...chunk);
      if(chunk.length<100){done=true;break;}
    }
    if(!done||!files.length||new Set(files).size!==files.length)
      throw new Error(`INCOMPLETE_FILES_${pr}`);
    const c=parseExactCi(pinned.head_sha,
      await api(`${prefix}/actions/runs?head_sha=${pinned.head_sha}&per_page=100`));
    const compare=obj(await api(`${prefix}/compare/${pinned.base_sha}...${pinned.head_sha}`));
    const merge=s(obj(compare.merge_base_commit).sha),status=s(compare.status);
    if(!sha.test(merge)||merge!==pinned.base_sha||status!=='ahead')
      throw new Error(`BAD_MERGE_BASE_${pr}`);
    nodes.push({...pinned,files,files_complete:true,
      compare:{base_sha:pinned.base_sha,head_sha:pinned.head_sha,
        merge_base_sha:merge,status},
      ci:{run_id:c.run_id,status:c.workflow_status??'unknown',
        conclusion:c.conclusion,queried_head_sha:pinned.head_sha}});
  }
  const after=await readAllOpenRefs(api,repo);
  if(JSON.stringify(before)!==JSON.stringify(after)||await main()!==mainBefore)
    throw new Error('OPEN_REFS_OR_MAIN_MOVED_DURING_SCAN');
  return {gate:'NO_GO' as const,main_sha:mainBefore,
    observed_open_count:before.length,verified_refs:before,
    inspected_details:targetIds,nodes,
    other_open_file_ci_not_refreshed:true,
    current_safe_merge_candidates:[] as never[],
    production_merge_authorized:false as const};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const repo=process.argv[2]??'';
  const token=process.env.GH_TOKEN||process.env.GITHUB_TOKEN||'';
  collect781790Live(githubRestRead(token),repo).then(r=>{
    process.stdout.write(JSON.stringify(r,null,2)+'\n');
    process.exitCode=2;
  }).catch(err=>{
    process.stderr.write('QA24_FAIL_CLOSED:'+(err instanceof Error?err.message:'UNKNOWN')+'\n');
    process.exitCode=3;
  });
}
