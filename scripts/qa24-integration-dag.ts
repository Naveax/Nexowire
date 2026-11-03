/**
 * #24 source-only PR integration DAG acceptance. Never merges branches or
 * grants CORE/ROOT authority. Snapshot findings are NOT runtime trust proof.
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export type CiStatus = {run_id:number; status:string; conclusion:string|null};
export type DagNode = {
  pr:number; parent_pr:number|null; base_sha:string; head_sha:string; ci:CiStatus;
};
export type MergeComparison = {
  pr:number; compare_base_sha:string; merge_base_sha:string; status:string;
};
export type FileClaim = {pr:number; owner:string; files:string[]};
export type DagSnapshot = {
  schema_version:number; repository:string; main_head:string;
  node_count:number; nodes:DagNode[]; comparisons:MergeComparison[];
  file_claims:FileClaim[]; observation_date:string;
};
export type Finding = {code:string; prs:number[]; detail:string};
const sha40 = /^[0-9a-f]{40}$/;

export function auditIntegrationDag(snapshot:DagSnapshot) {
  const findings:Finding[] = [];
  const add=(code:string,prs:number[],detail:string)=>findings.push({code,prs,detail});
  const nodes=snapshot.nodes ?? [];
  const byId=new Map<number,DagNode>();
  if(snapshot.schema_version!==1) add('SCHEMA_UNSUPPORTED',[],'Snapshot schema must be 1');
  if(!sha40.test(snapshot.main_head)) add('INVALID_MAIN_SHA',[],'Main HEAD must be an exact 40-hex SHA');
  if(nodes.length!==snapshot.node_count) add('NODE_COUNT_MISMATCH',[],
    'Declared and observed PR counts differ');
  for(const n of nodes) {
    if(!Number.isSafeInteger(n.pr)||n.pr<=0||byId.has(n.pr)) {
      add('DUPLICATE_OR_INVALID_PR',[n.pr],'PR IDs must be unique positive integers');
    }
    byId.set(n.pr,n);
    if(!sha40.test(n.head_sha)||!sha40.test(n.base_sha)) {
      add('INVALID_SHA',[n.pr],'Exact 40-byte-hex commit SHA required');
    }
    if(!Number.isSafeInteger(n.ci?.run_id)||n.ci.run_id<=0) {
      add('MISSING_EXACT_HEAD_CI',[n.pr],'No pinned workflow run ID');
    }
    if(!['completed','queued','in_progress'].includes(n.ci?.status)) {
      add('INVALID_CI_STATE',[n.pr],'Unknown workflow lifecycle');
    }
    if(n.ci?.status==='completed'&&!['success','failure','cancelled','timed_out','skipped','action_required','neutral'].includes(n.ci.conclusion??'')) {
      add('INVALID_CI_CONCLUSION',[n.pr],'Completed CI has no known terminal conclusion');
    }
    if(n.ci?.status!=='completed'&&n.ci?.conclusion!==null) {
      add('INVALID_PENDING_CI',[n.pr],'Pending CI must have a null conclusion');
    }
    if(n.ci?.conclusion==='failure') add('RED_CI',[n.pr],`CI run ${n.ci.run_id} failed`);
    else if(n.ci?.status!=='completed'||n.ci?.conclusion!=='success') {
      add('UNVERIFIED_CI',[n.pr],`CI run ${n.ci?.run_id} is not successful`);
    }
  }
  for(const n of nodes) {
    if(n.parent_pr===null) continue;
    const parent=byId.get(n.parent_pr);
    if(!parent) {add('MISSING_PARENT',[n.pr,n.parent_pr],'Parent PR absent from snapshot');continue;}
    if(n.base_sha!==parent.head_sha) {
      add('STALE_PARENT_SHA',[n.pr,n.parent_pr],
        `Child base ${n.base_sha}, parent HEAD ${parent.head_sha}`);
    }
    if(parent.ci.conclusion!=='success'||parent.ci.status!=='completed') {
      add('PARENT_CI_NOT_GREEN',[n.pr,n.parent_pr],'Green child cannot override parent failure');
    }
  }
  // Cycle-proof traversal is bounded even for attacker-controlled snapshots.
  const ancestry=(child:number,possibleAncestor:number):boolean=>{
    const visited=new Set<number>(); let cursor=byId.get(child);
    while(cursor?.parent_pr!==null&&cursor?.parent_pr!==undefined) {
      const parent=cursor.parent_pr;
      if(parent===possibleAncestor) return true;
      if(visited.has(parent)) return false;
      visited.add(parent); cursor=byId.get(parent);
    }
    return false;
  };
  for(const n of nodes) if(ancestry(n.pr,n.pr)) {
    add('DEPENDENCY_CYCLE',[n.pr],'PR dependency contains a cycle');
  }
  for(const c of snapshot.comparisons??[]) {
    const n=byId.get(c.pr);
    if(!n) {add('UNKNOWN_COMPARISON_PR',[c.pr],'Compare refers to absent PR');continue;}
    if(!sha40.test(c.compare_base_sha)||!sha40.test(c.merge_base_sha)) {
      add('INVALID_COMPARISON_SHA',[c.pr],'Compare must pin exact SHA');continue;
    }
    if(n.parent_pr!==null) {
      const parent=byId.get(n.parent_pr);
      if(parent&&c.compare_base_sha!==parent.head_sha) {
        add('COMPARE_NOT_CURRENT_PARENT',[n.pr,parent.pr],'Comparison did not use current parent HEAD');
      }
      if(c.merge_base_sha!==c.compare_base_sha||c.status!=='ahead') {
        add('STALE_MERGE_BASE',[n.pr,n.parent_pr],'Child comparison is not strictly ahead of parent');
      }
    } else if(c.status==='diverged') {
      add('DIVERGED_MAIN',[c.pr],'Main comparison is divergent; integrator must reconcile');
    }
  }
  // Every claim is explicitly a sampled GitHub changed-file list, not an
  // exclusive authoritative file-ownership registry.
  const claims=snapshot.file_claims??[];
  for(let i=0;i<claims.length;i++) for(let j=i+1;j<claims.length;j++) {
    const a=claims[i]!,b=claims[j]!;
    if(!byId.has(a.pr)||!byId.has(b.pr)) {
      add('UNKNOWN_OWNER_CLAIM',[a.pr,b.pr],'Changed-file claim references missing PR');
      continue;
    }
    if(ancestry(a.pr,b.pr)||ancestry(b.pr,a.pr)) continue;
    const overlap=a.files.filter(path=>b.files.includes(path));
    if(overlap.length) add('OWNER_COLLISION',[a.pr,b.pr],
      `Independent lineages overlap: ${overlap.sort().join(', ')}`);
  }
  findings.sort((a,b)=>a.code.localeCompare(b.code)||a.prs[0]! - b.prs[0]!);
  return {
    repository:snapshot.repository,
    main_head:snapshot.main_head,
    node_count:nodes.length,
    edge_count:nodes.filter(n=>n.parent_pr!==null).length,
    gate:'NO_GO' as const,
    // Source-only always remains NO_GO irrespective of the snapshot.
    findings,
    edges:nodes.filter(n=>n.parent_pr!==null).map(n=>({from:n.parent_pr!,to:n.pr})),
  };
}

export function loadPinnedSnapshot():DagSnapshot {
  const path=fileURLToPath(new URL('../docs/qa/p0-integration-dag-20261021.json',import.meta.url));
  return JSON.parse(readFileSync(path,'utf8')) as DagSnapshot;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const result=auditIntegrationDag(loadPinnedSnapshot());
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  process.exitCode=result.findings.length?2:0;
}
