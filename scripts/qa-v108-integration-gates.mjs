/**
 * Nexowire v1.0.8 read-only PR/CI integration gate.
 * Never dispatches workflows, merges PRs, deploys, or changes devices.
 * Successful source CI is NOT physical CORE authority.
 */
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const REPO='Naveax/Nexowire';
const CI='.github/workflows/ci.yml';
const sha40=x=>typeof x==='string'&&/^[0-9a-f]{40}$/.test(x);
const active=x=>['queued','waiting','pending','in_progress','requested'].includes(x);
const required=Object.freeze([
  'test (22)','test (24)','browser-live','linux-native-live',
  'wsl2-live','security-operational-live','macos-agent-lifecycle-live',
]);
const unique=(items,code)=>{if(!items.includes(code))items.push(code);};

// Explicit dependency graph. A CI-green Draft PR is not merge authorization.
export const STACK=Object.freeze([
  {number:980,head:'integration/core-after-v108-20261030',base:'main'},
  {number:981,head:'core/bounded-native-verifier-host-20261030',parent:980},
  {number:982,head:'core/native-verifier-mtls-client-20261031',parent:981},
  {number:983,head:'local/persistent-enrollment-design-20261031',parent:982},
  {number:984,head:'local/persistent-enrollment-v2-20261031',parent:983},
  {number:986,head:'ai/01-wal-v108',base:'main'},
  {number:993,head:'ai/02-enrollment-hardening-20261031',parent:984,extra:'local-enrollment-native'},
  {number:988,head:'ai/03-native-verifier-20261031',parent:982},
  {number:987,head:'ai/04-broker-admission-20261031',parent:980},
  {number:992,head:'ai/05-cas-executor',parent:980},
  {number:985,head:'ai/06-console-claim',parent:980},
  {number:990,head:'ai/07-isolation-worker-20261031',base:'docs/07-task-os-sandbox-provider-contract-20261024'},
  {number:989,head:'ai/08-independent-qa-20261031',parent:984},
]);

/** Pure, fail-closed snapshot evaluation. Fixture evidence remains untrusted. */
export function evaluateSnapshot(snapshot,{live=false}={}) {
  const prs=Array.isArray(snapshot?.prs)?snapshot.prs:[];
  const byId=new Map(prs.map(p=>[p?.number,p]));
  const nodes=[],findings=[];
  const mainOk=sha40(snapshot?.mainSha);
  if(!mainOk)unique(findings,'MAIN_SHA_INVALID');
  // GitHub state is not transactional. Refetch the exact HEAD/base at the
  // end of the read-only scan, and refuse source signoff on moving refs.
  const recheck=snapshot?.rechecked;
  const recheckPrs=Array.isArray(recheck?.prs)?new Map(recheck.prs.map(p=>[p?.number,p])):null;
  if(live||recheck!==undefined){
    if(!recheckPrs||!sha40(recheck?.mainSha)){
      unique(findings,'FINAL_HEAD_RECHECK_MISSING');
    }else if(recheck.mainSha!==snapshot.mainSha){
      unique(findings,'MAIN_MOVED_DURING_AUDIT');
    }
  }
  for(const spec of STACK){
    const errors=[],pr=byId.get(spec.number);
    if(!pr||pr.state!=='open'||!sha40(pr.head?.sha)||!sha40(pr.base?.sha)){
      unique(errors,'PR_MISSING_CLOSED_OR_INVALID');
    }else{
      if(pr.head.ref!==spec.head)unique(errors,'HEAD_BRANCH_DRIFT');
      const parent=spec.parent?byId.get(spec.parent):null;
      const expectedBase=spec.parent?STACK.find(p=>p.number===spec.parent)?.head:spec.base;
      if(pr.base.ref!==expectedBase)unique(errors,'BASE_BRANCH_DRIFT');
      if(spec.parent&&(!sha40(parent?.head?.sha)||pr.base.sha!==parent.head.sha)){
        unique(errors,'BASE_HEAD_SHA_MISMATCH');
      }
      if(spec.base==='main'&&(!mainOk||pr.base.sha!==snapshot.mainSha)){
        unique(errors,'BASE_MAIN_SHA_MISMATCH');
      }
      if(pr.draft!==true)unique(errors,'DRAFT_STATE_CHANGED_REVIEW');
      if(live||recheck!==undefined){
        const refreshed=recheckPrs?.get(spec.number);
        if(!refreshed||refreshed.state!=='open'){
          unique(errors,'PR_GONE_DURING_AUDIT');
        }else if(refreshed.head?.sha!==pr.head.sha||
          refreshed.base?.sha!==pr.base.sha||
          refreshed.head?.ref!==pr.head.ref||
          refreshed.base?.ref!==pr.base.ref||
          refreshed.draft!==pr.draft){
          unique(errors,'PR_MOVED_DURING_AUDIT');
        }
      }
    }
    const inputRuns=Array.isArray(snapshot?.runs?.[spec.number])?snapshot.runs[spec.number]:[];
    const matches=inputRuns.filter(r=>r?.name==='CI'&&
      typeof r.path==='string'&&r.path.startsWith(CI)&&r.head_sha===pr?.head?.sha);
    if(!matches.length)unique(errors,'EXACT_HEAD_CI_MISSING');
    if(matches.some(r=>active(r.status)))unique(errors,'EXACT_HEAD_CI_ACTIVE');
    if(matches.filter(r=>active(r.status)).length>1)unique(errors,'DUPLICATE_ACTIVE_CI');
    const sorted=[...matches].sort((a,b)=>
      String(b.created_at??'').localeCompare(String(a.created_at??''))||
      (Number(b.id)||0)-(Number(a.id)||0));
    const run=sorted[0];
    if(run){
      if(run.status!=='completed')unique(errors,'EXACT_HEAD_CI_PENDING');
      else if(run.conclusion!=='success')unique(errors,'EXACT_HEAD_CI_NOT_GREEN');
      if(!Number.isSafeInteger(run.id)||run.id<1)unique(errors,'CI_RUN_ID_INVALID');
      if(!Array.isArray(run.jobs)||!run.jobs.length){
        unique(errors,'CI_JOB_EVIDENCE_MISSING');
      }else{
        const counts=new Map();
        for(const job of run.jobs){
          if(typeof job?.name!=='string'){unique(errors,'CI_JOB_INVALID');continue;}
          counts.set(job.name,(counts.get(job.name)??0)+1);
          if(job.status!=='completed'||job.conclusion!=='success'){
            unique(errors,'CI_JOB_NOT_GREEN');
          }
          if(job.run_id!==undefined&&job.run_id!==run.id)unique(errors,'CI_JOB_RUN_ID_MISMATCH');
          if(job.head_sha!==undefined&&job.head_sha!==pr?.head?.sha){
            unique(errors,'CI_JOB_SHA_MISMATCH');
          }
        }
        for(const name of [...required,...(spec.extra?[spec.extra]:[])]){
          if(counts.get(name)!==1)unique(errors,'CI_REQUIRED_JOB_MISSING_OR_DUPLICATED');
        }
      }
    }
    nodes.push({number:spec.number,headSha:pr?.head?.sha??null,base:pr?.base?.ref??null,
      runId:run?.id??null,status:run?.status??'missing',
      conclusion:run?.conclusion??null,findings:errors});
    for(const error of errors)unique(findings,'PR_'+spec.number+':'+error);
  }
  return {
    repository:REPO,mainSha:snapshot?.mainSha??null,
    origin:live?'LIVE_GITHUB_API':'UNTRUSTED_FIXTURE',
    allSourceCisGreen:findings.length===0,
    sourceReview:findings.length?'BLOCKED':'SOURCE_CI_COMPLETE_REVIEW_REQUIRED',
    findings,nodes,physicalAcceptance:'NOT_PROVEN',
    productionCore:'NO_GO',mergeAuthorized:false,deployAuthorized:false,
  };
}

async function fetchJson(endpoint) {
  const token=process.env.GITHUB_TOKEN?.trim();
  const response=await fetch('https://api.github.com/repos/'+REPO+endpoint,{
    headers:{Accept:'application/vnd.github+json',
      'User-Agent':'nexowire-v108-coordinator-readonly',
      ...(token?{Authorization:'Bearer '+token}:{})},
    signal:AbortSignal.timeout(15000),
  });
  if(!response.ok)throw new Error('GitHub read-only request failed: HTTP '+response.status);
  const body=await response.text();
  if(body.length>5_000_000)throw new Error('GitHub response over 5MB');
  return JSON.parse(body);
}

async function fetchLiveSnapshot(){
  const main=await fetchJson('/commits/main');
  const prs=[];
  for(let page=1;page<=6;page++){
    const batch=await fetchJson('/pulls?state=open&per_page=100&page='+page);
    if(!Array.isArray(batch))throw new Error('Invalid GitHub PR response');
    prs.push(...batch);
    if(batch.length<100)break;
    if(page===6)throw new Error('GitHub PR pages incomplete');
  }
  const selected=prs.filter(p=>STACK.some(s=>s.number===p.number)),runs={};
  for(const pr of selected){
    if(!sha40(pr.head?.sha))continue;
    const batch=await fetchJson('/actions/runs?head_sha='+pr.head.sha+'&per_page=100');
    if(!Array.isArray(batch.workflow_runs))throw new Error('Invalid GitHub CI response');
    runs[pr.number]=[];
    const matches=batch.workflow_runs.filter(r=>r.name==='CI'&&
      typeof r.path==='string'&&r.path.startsWith(CI));
    if(batch.total_count>100)throw new Error('CI pages incomplete');
    for(const run of matches.slice(0,8)){
      const jobs=await fetchJson('/actions/runs/'+run.id+'/jobs?per_page=100');
      if(!Array.isArray(jobs.jobs)||jobs.total_count>100){
        throw new Error('CI job pages incomplete');
      }
      runs[pr.number].push({...run,jobs:jobs.jobs});
    }
  }
  // A successful CI for an older PR snapshot must not be promoted when an
  // agent pushes a new commit while its jobs are being inspected.
  const finalMain=await fetchJson('/commits/main');
  const finalPrs=[];
  for(const pr of selected){
    finalPrs.push(await fetchJson('/pulls/'+pr.number));
  }
  return {mainSha:main.sha,prs:selected,runs,
    rechecked:{mainSha:finalMain.sha,prs:finalPrs}};
}

function report(result){
  const lines=[
    '# Nexowire v1.0.8 read-only integration audit',
    '- Source: '+result.origin,
    '- Main SHA: '+result.mainSha,
    '- Source review: **'+result.sourceReview+'**',
    '- CORE production: **NO_GO** (physical owner proof, rollback, native authority not proven)',
    '- No merge, CI dispatch, deployment or live device operations performed.',
    '',
    '| PR | Head | Exact-head CI | Findings |',
    '| --- | --- | --- | --- |',
  ];
  for(const n of result.nodes){
    lines.push('| #'+n.number+' | '+String(n.headSha??'missing').slice(0,12)+
      ' | '+n.status+'/'+String(n.conclusion??'-')+' ('+String(n.runId??'-')+
      ') | '+(n.findings.join(', ')||'CI green; human review required')+' |');
  }
  return lines.join('\n')+'\n';
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const argv=process.argv.slice(2);
    if(argv.length!==0&&(argv.length!==2||argv[0]!=='--fixture')){
      throw new Error('Usage: node scripts/qa-v108-integration-gates.mjs [--fixture snapshot.json]');
    }
    const live=argv.length===0;
    let snapshot;
    if(live)snapshot=await fetchLiveSnapshot();
    else{
      const payload=await readFile(argv[1],'utf8');
      if(payload.length>1_000_000)throw new Error('Fixture exceeds 1MiB');
      snapshot=JSON.parse(payload);
    }
    const result=evaluateSnapshot(snapshot,{live});
    process.stdout.write(report(result));
    if(!result.allSourceCisGreen)process.exitCode=2;
  }catch(e){
    process.stderr.write('Read-only integration audit blocked: '+
      (e instanceof Error?e.message:'unknown error')+'\n');
    process.exitCode=2;
  }
}