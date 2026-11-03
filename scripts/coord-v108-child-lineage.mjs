/**
 * Nexowire 1.0.8 coordinator: read-only exact HEAD/base child-PR audit.
 * Detects an already-CI-green child whose parent moved.
 * Never modifies refs, starts CI, merges, deploys, or grants CORE.
 */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO='Naveax/Nexowire';
const sha40=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
export const PAIRS=Object.freeze([
  {parent:990,child:1004,label:'AI-07 native diagnostic rename'},
  {parent:980,child:1005,label:'CORE journal-owner integration'},
  {parent:985,child:1007,label:'CORE native claim combined QA'},
]);

export function auditLineage(snapshot,{live=false}={}) {
  const details=Array.isArray(snapshot?.prs)?snapshot.prs:[];
  const byId=new Map();
  const duplicateIds=[];
  for(const p of details){
    if(!Number.isSafeInteger(p?.number))continue;
    if(byId.has(p.number))duplicateIds.push(p.number);
    byId.set(p.number,p);
  }
  const findings=duplicateIds.map(id=>'DUPLICATE_PR_'+id);
  const nodes=[];
  const after=Array.isArray(snapshot?.rechecked?.prs)?
    new Map(snapshot.rechecked.prs.map(p=>[p?.number,p])):null;
  if(live&&(!after||after.size!==byId.size))findings.push('RECHECK_INCOMPLETE');
  for(const spec of PAIRS){
    const errs=[];
    const parent=byId.get(spec.parent),child=byId.get(spec.child);
    if(!parent||!child){errs.push('PR_MISSING');}
    else {
      for(const [who,pr] of [['PARENT',parent],['CHILD',child]]){
        if(pr.state!=='open'||pr.draft!==true||
          !sha40(pr.head?.sha)||!sha40(pr.base?.sha)||
          typeof pr.head?.ref!=='string'||typeof pr.base?.ref!=='string'){
          errs.push(who+'_STATE_OR_SHA_INVALID');
        }
      }
      if(!errs.length){
        if(child.base.ref!==parent.head.ref)errs.push('PARENT_REF_MISMATCH');
        if(child.base.sha!==parent.head.sha)errs.push('STALE_PARENT_HEAD');
        if(live||after){
          for(const pr of [parent,child]){
            const latest=after?.get(pr.number);
            if(!latest||latest.state!==pr.state||latest.draft!==pr.draft||
              latest.head?.sha!==pr.head.sha||latest.base?.sha!==pr.base.sha||
              latest.head?.ref!==pr.head.ref||latest.base?.ref!==pr.base.ref){
              errs.push('PR_MOVED_DURING_AUDIT');
            }
          }
        }
      }
    }
    nodes.push({parent:spec.parent,child:spec.child,label:spec.label,
      parentHead:parent?.head?.sha??null,childHead:child?.head?.sha??null,
      childBase:child?.base?.sha??null,
      status:errs.length?'BLOCKED':'LINEAGE_ALIGNED_REVIEW_REQUIRED',findings:errs});
    for(const e of errs)findings.push('PR_'+spec.child+':'+e);
  }
  return {schemaVersion:1,repository:REPO,origin:live?'LIVE_GITHUB_RECHECKED':'UNTRUSTED_FIXTURE',
    status:findings.length?'BLOCKED':'LINEAGE_ALIGNED_REVIEW_REQUIRED',
    findings,nodes,mergeAuthorized:false,deployAuthorized:false,
    physicalAcceptance:'NOT_PROVEN',productionCore:'NO_GO'};
}

async function requestPR(number){
  const token=process.env.GITHUB_TOKEN?.trim();
  const response=await fetch('https://api.github.com/repos/'+REPO+'/pulls/'+number,{
    headers:{Accept:'application/vnd.github+json',
      'User-Agent':'nexowire-v108-child-lineage-readonly',
      ...(token?{Authorization:'Bearer '+token}:{})},
    signal:AbortSignal.timeout(15000),
  });
  if(!response.ok)throw new Error('GITHUB_READ_ONLY_HTTP_'+response.status);
  const payload=await response.text();
  if(payload.length>1000000)throw new Error('RESPONSE_OVER_1MB');
  const pr=JSON.parse(payload);
  return {number:pr.number,state:pr.state,draft:pr.draft,
    head:{ref:pr.head?.ref,sha:pr.head?.sha},
    base:{ref:pr.base?.ref,sha:pr.base?.sha}};
}

async function fetchLiveSnapshot(){
  const ids=[...new Set(PAIRS.flatMap(({parent,child})=>[parent,child]))];
  const prs=[];
  for(const id of ids)prs.push(await requestPR(id));
  const rechecked=[];
  for(const id of ids)rechecked.push(await requestPR(id));
  return {prs,rechecked:{prs:rechecked}};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2);
    if(args.length!==0&&(args.length!==2||args[0]!=='--fixture')){
      throw new Error('Usage: node scripts/coord-v108-child-lineage.mjs [--fixture FILE.json]');
    }
    const live=args.length===0;
    let snapshot;
    if(live)snapshot=await fetchLiveSnapshot();
    else {
      const raw=await readFile(args[1],'utf8');
      if(raw.length>1000000)throw new Error('FIXTURE_OVER_1MB');
      snapshot=JSON.parse(raw);
    }
    const result=auditLineage(snapshot,{live});
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
    if(result.status==='BLOCKED')process.exitCode=2;
  }catch(error){
    process.stderr.write('V108_CHILD_LINEAGE_BLOCKED: '+(error instanceof Error?error.message:'UNKNOWN')+'\n');
    process.exitCode=2;
  }
}