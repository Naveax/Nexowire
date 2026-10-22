import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {adjudicateNext2,collectNext2DoublePass}
 from '../scripts/qa24-next2-full-doublepass.js';
import type {GithubRead,LiveSnapshot,LiveNode} from '../scripts/qa24-live-dag.js';

type Row={pr:number;head_sha:string;base_sha:string;base_ref:string;files:string[];
  run_id:number;conclusion:string;compare:string;merge_base_sha:string};
const fix=JSON.parse(readFileSync(fileURLToPath(
 new URL('../docs/qa/fixtures/qa24-next2-critical-evidence-20261023.json',import.meta.url)
),'utf8')) as {main_head:string;pr_rows:Row[]};
const branch=new Map<number,string>([
 [708,'test/22-691-crosshub-dispatch-20261021'],
 [726,'qa/23-ui-native-cas-reconnect-20261021'],
 [786,'qa/w26-780-worktree-root-escape-20261022'],
 [800,'test/20-780-git-fsmonitor-hook-escape-20261022'],
 [801,'test/09-cdp-micro-scenario-contract-20261022'],
 [802,'test/qa16-pr779-790-ci-provenance-20261022'],
 [810,'test/24-delta-791-803-paged-source-20261022'],
 [811,'fix/31-scoped-git-executor-20261022'],
 [814,'test/37-adversarial-git-metadata-20261023'],
 [821,'test/50-p1-git-clean-filter-red-20261023'],
 [826,'fix/01-runbook-native-admission-failclosed-20261023'],
 [831,'test/44-open-pr-dag-exact-ci-20261023'],
 [837,'test/qa16-pr806-811-physical-proof-20261023']
]);
const SHA=(n:number)=>n.toString(16).padStart(40,'0');
const refs=(count:number):LiveNode[]=>{
 const rows=fix.pr_rows.map(r=>({
  pr:r.pr,title:'QA_'+r.pr,head_ref:branch.get(r.pr)!,head_sha:r.head_sha,
  base_sha:r.base_sha,base_ref:r.base_ref,parent_pr:r.base_ref==='fix/31-scoped-git-executor-20261022'?811:null,
  draft:true,files:r.files,files_complete:true,
  ci:{status:r.conclusion==='success'?'success' as const:'failure' as const,
    run_id:r.run_id,run_head_sha:r.head_sha,workflow_status:'completed',conclusion:r.conclusion},
  merge_base_sha:r.merge_base_sha,compare_status:r.compare
 }));
 const rest=Array.from({length:count-rows.length},(_,i)=>{
  const pr=10000+i,head=SHA(pr+10000);
  return {pr,title:'filler',head_ref:'filler-'+pr,head_sha:head,
   base_ref:'main',base_sha:fix.main_head,parent_pr:null,draft:true,
   files:['test/filler-'+pr+'.ts'],files_complete:true,
   ci:{status:'success' as const,run_id:400000000+pr,run_head_sha:head,
    workflow_status:'completed',conclusion:'success'},
   merge_base_sha:fix.main_head,compare_status:'ahead'};
 });
 return [...rows,...rest].sort((a,b)=>a.pr-b.pr);
};
const snap=(count=235):LiveSnapshot=>({
 schema_version:2,repository:'Naveax/Nexowire',observed_at:'synthetic-test',
 main_head:fix.main_head,source:'github-rest-readonly',open_pr_count:count,
 open_prs_complete:true,nodes:refs(count),errors:[]
});
test('NEXT2 full source green #811 cannot override red children, red runbook, or P0',()=>{
 const v=snap(),report=adjudicateNext2(v,structuredClone(v));
 assert.equal(report.open_count,235);
 assert.equal(report.full_two_pass_details_verified,true);
 assert.equal(report.production_merge_authorized,false);
 assert.deepEqual(report.safe_merge_queue,[]);
 assert.ok(report.critical_blockers.some(x=>x.pr===811&&x.reason==='HOSTILE_CHILD_RED'&&x.related===821));
 assert.ok(report.critical_blockers.some(x=>x.pr===811&&x.reason==='HOSTILE_CHILD_RED'&&x.related===814));
 for(const pr of [708,726,814,821,826,837])
   assert.ok(report.critical_blockers.some(x=>x.pr===pr),String(pr));
 assert.ok(report.critical_blockers.some(x=>x.reason==='INDEPENDENT_WORKFLOW_OWNER_COLLISION'));
 assert.ok(report.differing_test_parent_sha.every(x=>x.sha_matches));
});
test('NEXT2 changing second pass exact SHA, CI, files or merge-base fails closed',()=>{
 for(const mutate of [
  (s:LiveSnapshot)=>{s.nodes.find(x=>x.pr===811)!.head_sha='a'.repeat(40);},
  (s:LiveSnapshot)=>{s.nodes.find(x=>x.pr===811)!.ci.conclusion='failure';},
  (s:LiveSnapshot)=>{s.nodes.find(x=>x.pr===811)!.files.push('src/changed.ts');},
  (s:LiveSnapshot)=>{s.nodes.find(x=>x.pr===811)!.merge_base_sha='b'.repeat(40);}
 ]){
  const first=snap(),second=structuredClone(first);mutate(second);
  assert.throws(()=>adjudicateNext2(first,second),/TWO_PASS_HEAD_BASE_FILES_CI_MERGE_BASE_MOVED/);
 }
});
test('NEXT2 completeness and critical PR absence deny even if all CI source GREEN',()=>{
 const first=snap();
 const invalid=structuredClone(first);invalid.errors=['torn'];
 assert.throws(()=>adjudicateNext2(first,invalid),/INCOMPLETE_FULL_PR_CENSUS/);
 const gone=structuredClone(first);gone.nodes=gone.nodes.filter(n=>n.pr!==821);
 gone.open_pr_count--;
 assert.throws(()=>adjudicateNext2(gone,structuredClone(gone)),/CRITICAL_PR_NOT_OPEN_821/);
});
function mockApi(count:number,opt?:{moved?:boolean;ciMoved?:boolean}):{
 api:GithubRead;stats:{pullPages:number;fileReads:number;ciReads:number;compares:number}
}{
 const rows=refs(count);
 let pullReads=0;
 const stats={pullPages:0,fileReads:0,ciReads:0,compares:0};
 const ciReadsBySha=new Map<string,number>();
 const api:GithubRead=async path=>{
  const u=new URL(path,'https://api.github.com');
  if(u.pathname.endsWith('/branches/main'))return {commit:{sha:fix.main_head}};
  if(u.pathname.endsWith('/pulls')){
   const page=Number(u.searchParams.get('page')||0);
   stats.pullPages++;
   if(page===1)pullReads++;
   const result=rows.map(n=>({
    number:n.pr,state:'open',title:n.title,draft:true,
    head:{sha:n.head_sha,ref:n.head_ref},
    base:{sha:n.base_sha,ref:n.base_ref}
   }));
   if(opt?.moved&&pullReads>=3){
    result.find(n=>n.number===811)!.head.sha='a'.repeat(40);
   }
   return result.slice((page-1)*100,page*100);
  }
  const pathFiles=u.pathname.match(/\/pulls\/(\d+)\/files$/);
  if(pathFiles){
   stats.fileReads++;
   const n=rows.find(x=>x.pr===Number(pathFiles[1]));if(!n)throw Error('UNKNOWN_FILE_OWNER');
   return Number(u.searchParams.get('page'))===1?n.files.map(filename=>({filename})):[];
  }
  if(u.pathname.endsWith('/actions/runs')){
   stats.ciReads++;
   const sha=u.searchParams.get('head_sha');
   const n=rows.find(x=>x.head_sha===sha)||
     (opt?.moved&&sha==='a'.repeat(40)?rows.find(x=>x.pr===811):undefined);
   if(!n)throw Error('UNKNOWN_CI_SHA');
   const count=(ciReadsBySha.get(sha!)||0)+1;ciReadsBySha.set(sha!,count);
   const altered=opt?.ciMoved&&n.pr===811&&count>=2;
   return {total_count:1,workflow_runs:[{
    id:n.ci.run_id,run_attempt:1,name:'CI',event:'pull_request',
    head_sha:sha,status:'completed',
    conclusion:altered?'failure':n.ci.conclusion
   }]};
  }
  const comp=u.pathname.match(/\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})$/);
  if(comp){
   stats.compares++;
   const n=rows.find(x=>x.base_sha===comp[1]&&x.head_sha===comp[2])||
     (opt?.moved&&comp[2]==='a'.repeat(40)?rows.find(x=>x.pr===811):undefined);
   if(!n)throw Error('UNKNOWN_COMPARE_SHA');
   return {status:n.compare_status,merge_base_commit:{sha:n.merge_base_sha}};
  }
  throw Error('UNEXPECTED_GET_'+path);
 };
 return {api,stats};
}
test('NEXT2 235 OPEN: full 100+100+35 GET, repeated all four metadata classes',async()=>{
 const {api,stats}=mockApi(235);
 const result=await collectNext2DoublePass(api,'Naveax/Nexowire');
 assert.equal(result.open_count,235);
 assert.equal(stats.fileReads,235*2);
 assert.equal(stats.ciReads,235*2);
 assert.equal(stats.compares,235*2);
 assert.equal(stats.pullPages,3*4); // first+recheck, twice; each uses 100/100/35
 assert.equal(result.gate,'NO_GO');
 assert.equal(result.physical_acceptance,'NOT_PROVEN');
});
test('NEXT2 torn REST PR HEAD or late CI change denies full snapshot',async()=>{
 await assert.rejects(collectNext2DoublePass(mockApi(235,{moved:true}).api,'Naveax/Nexowire'),
  /SNAPSHOT_MOVED_DURING_COLLECTION|TWO_PASS_HEAD_BASE_FILES_CI_MERGE_BASE_MOVED/);
 await assert.rejects(collectNext2DoublePass(mockApi(235,{ciMoved:true}).api,'Naveax/Nexowire'),
  /TWO_PASS_HEAD_BASE_FILES_CI_MERGE_BASE_MOVED/);
});
