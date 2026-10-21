/**
 * #24 independent safe-merge REVIEW queue. This NEVER gives production authorization,
 * calls GitHub mutations or merges a branch. Claims are a frozen observation.
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

type SnapshotNode={
  pr:number;parent_pr:number|null;base_sha:string;head_sha:string;
  ci:{run_id:number;status:string;conclusion:string|null;queried_head_sha?:string};
};
type Claim={pr:number;files:string[];scope?:string};
type Comparison={pr:number;compare_base_sha:string;merge_base_sha:string;status:string};
export type FrozenSnapshot={
  main_head:string;open_pr_count:number;nodes:SnapshotNode[];
  file_claims:Claim[];comparisons:Comparison[];
};
type Risk={pr:number;codes:string[]};
const sha=/^[0-9a-f]{40}$/;
const sourceOnly=(path:string)=>/^(test\/|docs\/|\.github\/workflows\/qa[-\w]*\.ya?ml$)/.test(path);
export function reviewFrozenDag(snapshot:FrozenSnapshot) {
  const nodes=new Map(snapshot.nodes.map(n=>[n.pr,n]));
  const claims=new Map(snapshot.file_claims.map(c=>[c.pr,c]));
  const comps=new Map(snapshot.comparisons.map(c=>[c.pr,c]));
  const allEvidenceComplete=snapshot.nodes.every(n=>claims.get(n.pr)?.scope==='all_changed_files');
  const getParents=(id:number)=>{const chain:number[]=[];const seen=new Set([id]);
    let p=nodes.get(id)?.parent_pr;
    while(p!==null&&p!==undefined&&!seen.has(p)){
      chain.push(p);seen.add(p);p=nodes.get(p)?.parent_pr;
    }
    if(p!==null&&p!==undefined)chain.push(p);
    return chain;
  };
  const risk:Risk[]=[];
  const candidate: Array<{pr:number;sha:string;review_status:string;requirements:string[]}>=[];
  const overlaps:Array<{prs:[number,number];files:string[]}>= [];
  const items=[...nodes.values()].sort((a,b)=>a.pr-b.pr);
  for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++){
    const a=items[i]!,b=items[j]!;
    if(getParents(a.pr).includes(b.pr)||getParents(b.pr).includes(a.pr))continue;
    const x=claims.get(a.pr)?.files??[],y=new Set(claims.get(b.pr)?.files??[]);
    const common=[...new Set(x.filter(f=>y.has(f)))].sort();
    if(common.length)overlaps.push({prs:[a.pr,b.pr],files:common});
  }
  for(const n of items) {
    const problems:string[]=[];
    const add=(c:string)=>{if(!problems.includes(c))problems.push(c);};
    if(!sha.test(n.head_sha)||!sha.test(n.base_sha))add('BAD_SHA');
    if(!Number.isSafeInteger(n.ci.run_id)||n.ci.run_id<=0||
      n.ci.queried_head_sha!==n.head_sha)add('CI_HEAD_UNVERIFIED');
    if(n.ci.status!=='completed'||n.ci.conclusion!=='success')add('CI_NOT_GREEN');
    if(n.parent_pr===null&&n.base_sha!==snapshot.main_head)add('MAIN_NOT_CURRENT');
    if(n.parent_pr!==null){
      const parent=nodes.get(n.parent_pr);
      if(!parent)add('UNKNOWN_PARENT');
      else if(n.base_sha!==parent.head_sha)add('STALE_PARENT');
    }
    for(const p of getParents(n.pr)){
      const par=nodes.get(p);
      if(!par){add('UNKNOWN_ANCESTOR');continue;}
      if(par.ci.conclusion!=='success'||par.ci.status!=='completed')add('ANCESTOR_CI_NOT_GREEN');
      if(par.parent_pr===null&&par.base_sha!==snapshot.main_head)add('ANCESTOR_MAIN_STALE');
      const gp=par.parent_pr===null?null:nodes.get(par.parent_pr);
      if(par.parent_pr!==null&&(!gp||par.base_sha!==gp.head_sha))add('ANCESTOR_SHA_STALE');
    }
    const compare=comps.get(n.pr);
    if(!compare||compare.compare_base_sha!==n.base_sha||
      compare.merge_base_sha!==n.base_sha||compare.status!=='ahead')
      add('MERGE_BASE_NOT_CURRENTLY_PROVEN');
    const own=claims.get(n.pr);
    if(!own||own.scope!=='all_changed_files')add('FILES_INCOMPLETE');
    if(!own||!own.files.length||own.files.some(f=>!sourceOnly(f)))add('NOT_SOURCE_ONLY');
    if(overlaps.some(o=>o.prs.includes(n.pr)))add('OWNER_COLLISION_REVIEW');
    // All candidate labels remain conditional because some other PRs have partial
    // paths, GitHub approvals/branch protection have not been checked, and snapshots age.
    if(!allEvidenceComplete)add('GLOBAL_FILE_COVERAGE_INCOMPLETE');
    if(n.parent_pr!==null)add('STACKED_REQUIRES_INTEGRATOR_REVIEW');
    const hard=problems.filter(code=>code!=='GLOBAL_FILE_COVERAGE_INCOMPLETE');
    if(!hard.length&&n.parent_pr===null){
      candidate.push({pr:n.pr,sha:n.head_sha,
        review_status:'CONDITIONAL_SOURCE_REVIEW_ONLY',
        requirements:['Requery current exact HEAD/base/CI and merge-base',
          'Fetch complete changed paths of every open PR',
          'Independent code/security owner approval and branch protection',
          'No P0 production merge without physical trust acceptance']});
    }
    risk.push({pr:n.pr,codes:problems});
  }
  return {gate:'NO_GO' as const,open_pr_count:snapshot.open_pr_count,
    pinned_nodes:snapshot.nodes.length,global_files_complete:allEvidenceComplete,
    review_candidates:candidate,
    owner_collisions:overlaps,
    risks:risk,
    automatic_merge_allowed:false as const};
}

export function readPinned77():FrozenSnapshot {
  return JSON.parse(readFileSync(fileURLToPath(new URL('../docs/qa/p0-integration-dag-open77-20261021.json',import.meta.url)),'utf8')) as FrozenSnapshot;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=reviewFrozenDag(readPinned77());
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  process.exitCode=2; // Frozen-source review never releases production.
}
