/**
 * Worker #24: GitHub REST live PR DAG. READ ONLY. No merges, reruns or elevation.
 * A green workflow is accepted ONLY for its exact PR head SHA.
 */
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export type CiEvidence = {
  status: 'success'|'failure'|'pending'|'unknown';
  run_id: number|null;
  run_head_sha: string|null;
  workflow_status: string|null;
  conclusion: string|null;
};
export type LiveNode = {
  pr:number; title:string; head_ref:string; head_sha:string;
  base_ref:string; base_sha:string; parent_pr:number|null;
  draft:boolean; files:string[]; files_complete:boolean;
  ci:CiEvidence; merge_base_sha:string|null; compare_status:string|null;
};
export type LiveSnapshot = {
  schema_version:2; repository:string; observed_at:string; main_head:string;
  source:'github-rest-readonly'; open_pr_count:number; open_prs_complete:boolean;
  nodes:LiveNode[]; errors:string[];
};
export type OldSnapshot = {
  main_head:string; nodes:Array<{pr:number;head_sha:string;base_sha:string;
    parent_pr:number|null;ci?:{run_id:number;status:string;conclusion:string|null}}>;
};
export type Finding = {code:string;prs:number[];detail:string};
export type GithubRead = (path:string)=>Promise<unknown>;
const sha40=/^[0-9a-f]{40}$/;
const nr=(o:unknown):Record<string,unknown> => {
  if(!o||typeof o!=='object'||Array.isArray(o)) throw new Error('BAD_GITHUB_OBJECT');
  return o as Record<string,unknown>;
};
const str=(x:unknown):string=>typeof x==='string'?x:'';
const num=(x:unknown):number=>typeof x==='number'&&Number.isSafeInteger(x)?x:0;
const arr=(x:unknown):unknown[]=>{
  if(!Array.isArray(x)) throw new Error('BAD_GITHUB_ARRAY');
  return x;
};
const branch=(x:unknown)=>{const o=nr(x);return {ref:str(o.ref),sha:str(o.sha)};};
const withErr=(cause:unknown)=>cause instanceof Error?cause.message:'UNKNOWN_GITHUB_ERROR';
const priority=(c:CiEvidence)=>c.status==='success'?0:c.status==='pending'?1:c.status==='unknown'?2:3;

/** Strict SHA-bound CI: never infer success from a different HEAD or a release workflow. */
export function parseExactCi(head:string,payload:unknown):CiEvidence {
  const obj=nr(payload);
  const runs=arr(obj.workflow_runs);
  if(num(obj.total_count)>runs.length) return {status:'unknown',run_id:null,
    run_head_sha:null,workflow_status:null,conclusion:null};
  const accepted=runs.map(nr).filter(r=>str(r.head_sha)===head&&str(r.name)==='CI'&&
    ['pull_request','pull_request_target'].includes(str(r.event)));
  accepted.sort((a,b)=>num(b.id)-num(a.id));
  const last=accepted[0];
  if(!last) return {status:'unknown',run_id:null,run_head_sha:null,
    workflow_status:null,conclusion:null};
  const status=str(last.status),conclusion=str(last.conclusion),id=num(last.id);
  const verdict:CiEvidence['status']=status!=='completed'?'pending':
    conclusion==='success'?'success':conclusion==='failure'?'failure':'unknown';
  return {status:verdict,run_id:id||null,run_head_sha:head,
    workflow_status:status,conclusion:conclusion||null};
}

export function auditLiveSnapshot(prior:OldSnapshot|LiveSnapshot,live:LiveSnapshot) {
  const findings:Finding[]=[];
  const add=(code:string,prs:number[],detail:string)=>findings.push({code,prs,detail});
  const old=new Map(prior.nodes.map(n=>[n.pr,n]));
  const cur=new Map(live.nodes.map(n=>[n.pr,n]));
  if(prior.main_head!==live.main_head)add('MAIN_MOVED',[],
    `old=${prior.main_head} live=${live.main_head}`);
  if(!live.open_prs_complete||live.open_pr_count!==live.nodes.length||
    live.errors.length) add('INCOMPLETE_LIVE_SNAPSHOT',[],live.errors.join('; ')||'PR enumeration incomplete');
  for(const n of live.nodes) {
    const previous=old.get(n.pr);
    if(!previous) add('NEW_OPEN_PR',[n.pr],'PR absent from older snapshot');
    else {
      if(previous.head_sha!==n.head_sha) add('HEAD_MOVED',[n.pr],
        `old=${previous.head_sha} new=${n.head_sha}`);
      if(previous.base_sha!==n.base_sha||previous.parent_pr!==n.parent_pr)
        add('BASE_MOVED',[n.pr],'Base SHA or parent changed');
      if(previous.ci?.run_id!==undefined&&previous.ci.run_id!==n.ci.run_id)
        add('CI_EVIDENCE_CHANGED',[n.pr],'Workflow run changed: old result is not reusable');
      const oldCi=previous.ci;
      if(oldCi&&('status' in oldCi)&&
        (oldCi.status!==(n.ci.workflow_status??'')||oldCi.conclusion!==n.ci.conclusion))
        add('CI_STATE_CHANGED',[n.pr],'CI state changed since the previous snapshot');
    }
    if(!sha40.test(n.head_sha)||!sha40.test(n.base_sha))
      add('INVALID_SHA',[n.pr],'Invalid exact HEAD/base SHA');
    if(!n.files_complete)add('INCOMPLETE_FILE_LIST',[n.pr],'Cannot exhaustively assess changed files');
    if(!n.ci.run_id||n.ci.run_head_sha!==n.head_sha)
      add('CI_UNVERIFIED_SHA',[n.pr],'Missing exact HEAD CI result');
    if(n.ci.status!=='success')add('CI_NOT_GREEN',[n.pr],
      `Exact HEAD workflow is ${n.ci.status}`);
    if(n.base_ref==='main'&&n.base_sha!==live.main_head)
      add('STALE_MAIN_BASE',[n.pr],'PR base does not match current main');
    if(n.parent_pr===null&&n.base_ref!=='main')
      add('UNRESOLVED_PARENT',[n.pr],`No current open parent for ${n.base_ref}`);
  }
  for(const n of prior.nodes)if(!cur.has(n.pr))
    add('NO_LONGER_OPEN',[n.pr],'Previously open PR is not currently open; do not infer merged');
  const ancestors=(child:number,possibleAncestor:number):boolean=>{
    const seen=new Set<number>();let p=cur.get(child)?.parent_pr;
    while(p!==null&&p!==undefined&&!seen.has(p)){
      if(p===possibleAncestor)return true;
      seen.add(p);p=cur.get(p)?.parent_pr;
    }
    return false;
  };
  for(const n of live.nodes) {
    if(n.parent_pr!==null) {
      const parent=cur.get(n.parent_pr);
      if(!parent)add('PARENT_MISSING',[n.pr,n.parent_pr],'Parent not in live snapshot');
      else {
        if(n.base_sha!==parent.head_sha)add('STALE_PARENT',[n.pr,parent.pr],
          'Child base SHA is not the live parent HEAD');
        if(parent.ci.status!=='success')add('PARENT_CI_NOT_GREEN',[n.pr,parent.pr],
          'Child success never overrides red/pending/unknown parent');
      }
      if(ancestors(n.pr,n.pr))add('DEPENDENCY_CYCLE',[n.pr],'Cyclic PR stack');
    }
    if(!n.merge_base_sha||n.compare_status===null)
      add('MERGE_BASE_UNKNOWN',[n.pr],'No verified compare for exact base and head');
    else if(n.merge_base_sha!==n.base_sha||n.compare_status!=='ahead')
      add('MERGE_BASE_RISK',[n.pr],'Compare is not cleanly ahead of latest target');
  }
  const paths=new Map<string,number[]>();
  for(const n of live.nodes)for(const f of new Set(n.files)){
    const ids=paths.get(f)??[];ids.push(n.pr);paths.set(f,ids);
  }
  for(const [path,ids] of paths)for(let i=0;i<ids.length;i++)
    for(let j=i+1;j<ids.length;j++){
      const a=ids[i]!,b=ids[j]!;
      if(!ancestors(a,b)&&!ancestors(b,a))add('OWNER_COLLISION',[a,b],path);
    }
  const hasDrift=findings.some(f=>['NEW_OPEN_PR','HEAD_MOVED','BASE_MOVED','NO_LONGER_OPEN','MAIN_MOVED','CI_EVIDENCE_CHANGED','CI_STATE_CHANGED','INCOMPLETE_LIVE_SNAPSHOT'].includes(f.code));
  if(hasDrift)add('STALE_SNAPSHOT',[],'Pinned historical graph differs from live GitHub');
  findings.sort((a,b)=>a.code.localeCompare(b.code)||((a.prs[0]??0)-(b.prs[0]??0))||
    a.detail.localeCompare(b.detail));
  return {gate:'NO_GO' as const,observed_at:live.observed_at,
    open_pr_count:live.open_pr_count,risk_count:findings.length,findings,
    risk_summary:{ci_red:live.nodes.filter(n=>n.ci.status==='failure').length,
      ci_pending:live.nodes.filter(n=>n.ci.status==='pending').length,
      ci_unknown:live.nodes.filter(n=>n.ci.status==='unknown').length,
      parent_not_green:findings.filter(f=>f.code==='PARENT_CI_NOT_GREEN').length,
      ownership_collisions:findings.filter(f=>f.code==='OWNER_COLLISION').length}};
}

async function allPages(api:GithubRead,path:string,key:string,maxPages=10):Promise<unknown[]> {
  const found:unknown[]=[];
  for(let page=1;page<=maxPages;page++){
    const sep=path.includes('?')?'&':'?';
    const value=await api(`${path}${sep}per_page=100&page=${page}`);
    const pageRows=key?arr(nr(value)[key]):arr(value);
    found.push(...pageRows);
    if(pageRows.length<100)return found;
  }
  throw new Error(`PAGINATION_LIMIT:${path}`);
}
async function boundedMap<T,U>(list:T[],limit:number,job:(item:T)=>Promise<U>):Promise<U[]> {
  const output:U[]=new Array(list.length);
  let index=0;
  await Promise.all(Array.from({length:Math.min(limit,list.length)},async()=>{
    for(;;){const i=index++;if(i>=list.length)return;output[i]=await job(list[i]!);}
  }));
  return output;
}
function exactPr(raw:unknown){
  const p=nr(raw),head=branch(p.head),base=branch(p.base);
  const pr=num(p.number);
  if(pr<=0||!sha40.test(head.sha)||!sha40.test(base.sha)||!head.ref||!base.ref)
    throw new Error('INCOMPLETE_PR_METADATA');
  return {pr,title:str(p.title),head_ref:head.ref,head_sha:head.sha,
    base_ref:base.ref,base_sha:base.sha,draft:p.draft===true};
}

/** Collects all OPEN PRs, CI, changed paths and true git merge-base comparisons. */
export async function collectLiveSnapshot(api:GithubRead,repo:string,
  observedAt=new Date().toISOString()):Promise<LiveSnapshot> {
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    throw new Error('INVALID_REPO');
  const prefix=`/repos/${repo}`;
  const branchHead=async()=>str(nr(nr(await api(`${prefix}/branches/main`)).commit).sha);
  const mainBefore=await branchHead();
  if(!sha40.test(mainBefore))throw new Error('MAIN_HEAD_UNAVAILABLE');
  const listed=(await allPages(api,`${prefix}/pulls?state=open`,'')).map(exactPr);
  const unique=new Set<number>(),heads=new Map<string,number>();
  for(const p of listed){
    if(unique.has(p.pr)||heads.has(p.head_ref))throw new Error('DUPLICATE_PR_OR_HEAD_BRANCH');
    unique.add(p.pr);heads.set(p.head_ref,p.pr);
  }
  const nodes=await boundedMap(listed,4,async p=>{
    const paths=(await allPages(api,`${prefix}/pulls/${p.pr}/files`,''))
      .map(item=>str(nr(item).filename));
    if(paths.some(path=>!path)||new Set(paths).size!==paths.length)
      throw new Error(`INCOMPLETE_CHANGED_FILES:${p.pr}`);
    const runs=await api(`${prefix}/actions/runs?head_sha=${p.head_sha}&per_page=100`);
    const ci=parseExactCi(p.head_sha,runs);
    const compare=nr(await api(`${prefix}/compare/${p.base_sha}...${p.head_sha}`));
    const mergeBase=str(nr(compare.merge_base_commit).sha);
    const status=str(compare.status);
    if(!sha40.test(mergeBase)||!status)throw new Error(`INCOMPLETE_MERGE_BASE:${p.pr}`);
    return {...p,parent_pr:heads.get(p.base_ref)??null,files:paths,files_complete:true,
      ci,merge_base_sha:mergeBase,compare_status:status} satisfies LiveNode;
  });
  // Re-read PR refs and main to avoid reporting a torn multi-PR snapshot.
  const listedAgain=(await allPages(api,`${prefix}/pulls?state=open`,'')).map(exactPr);
  const stable=(list:typeof listed)=>JSON.stringify(list.map(p=>
    [p.pr,p.head_sha,p.base_sha,p.base_ref]).sort((a,b)=>Number(a[0])-Number(b[0])));
  if(stable(listed)!==stable(listedAgain)||mainBefore!==await branchHead())
    throw new Error('SNAPSHOT_MOVED_DURING_COLLECTION');
  nodes.sort((a,b)=>a.pr-b.pr);
  return {schema_version:2,repository:repo,observed_at:observedAt,
    main_head:mainBefore,source:'github-rest-readonly',open_pr_count:nodes.length,
    open_prs_complete:true,nodes,errors:[]};
}

export function githubRestRead(token:string,origin='https://api.github.com'):GithubRead {
  if(!token)throw new Error('GITHUB_TOKEN_REQUIRED');
  return async path=>{
    const response=await fetch(new URL(path,origin),{method:'GET',headers:{
      'Accept':'application/vnd.github+json',
      'Authorization':`Bearer ${token}`,
      'X-GitHub-Api-Version':'2022-11-28',
      'User-Agent':'Nexowire-QA24-readonly',
    }});
    if(!response.ok)throw new Error(`GITHUB_READ_FAILED_HTTP_${response.status}`);
    return response.json() as Promise<unknown>;
  };
}

async function cli(){
  const argv=process.argv.slice(2);
  if(argv.length!==3||argv[0]!=='--repo'){
    throw new Error('usage: node --import tsx scripts/qa24-live-dag.ts --repo owner/repo SNAPSHOT.json');
  }
  const token=process.env.GH_TOKEN||process.env.GITHUB_TOKEN||'';
  const prior=JSON.parse(readFileSync(argv[2]!,'utf8')) as OldSnapshot|LiveSnapshot;
  const snapshot=await collectLiveSnapshot(githubRestRead(token),argv[1]!);
  const results=auditLiveSnapshot(prior,snapshot);
  // Emits to stdout only. Caller may redirect after independently reviewing.
  // Never print token, command payloads, cookies or user secrets.
  process.stdout.write(JSON.stringify({snapshot,comparison:results},null,2)+'\n');
  process.exitCode=results.risk_count?2:0;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  cli().catch(e=>{process.stderr.write(`QA24_FAIL_CLOSED:${withErr(e)}\n`);process.exitCode=3;});
}
