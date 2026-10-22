import test from 'node:test';
import assert from 'node:assert/strict';
import {collectQa24FullReview,qa24ReleaseGate}
  from '../scripts/qa24-full-merge-gate-811.js';
import type {GithubRead,LiveSnapshot} from '../scripts/qa24-live-dag.js';

const main='754cc4364822be5fda528f54042fb22a84f19924';
const sha=(n:number)=>n.toString(16).padStart(40,'0');
const ciSpecial=new Map<number,'success'|'failure'>([
  [708,'failure'],[726,'failure'],[786,'failure'],[800,'failure'],
  [801,'success'],[802,'failure'],[811,'success']]);
const filesSpecial=new Map<number,string[]>([
  [708,['test/qa22-crosshub-cas-fencing.test.ts']],
  [726,['test/core-effective-native-cas-ui-gate.test.ts']],
  [786,['test/p26-780-git-worktree-root-escape-negative.test.ts']],
  [800,['test/p20-780-git-fsmonitor-hook-escape-negative.test.ts']],
  [801,['.github/workflows/ci.yml','src/agent/browser-micro-scenario-contract.ts']],
  [802,['.github/workflows/ci.yml','test/qa-779-790-failed-step-provenance.test.ts']],
  [811,['src/agent/executors.ts','test/p20-780-git-fsmonitor-hook-escape-negative.test.ts',
    'test/p26-780-git-worktree-root-escape-negative.test.ts']]
]);
type Opt={newOnSecondPass?:boolean;changeHead?:boolean;ciWrongSha?:boolean;
  incompleteFiles?:boolean;badCompare?:boolean;ciFlip?:boolean;filesFlip?:boolean};
function mock(total:number,opts:Opt={}) {
  let reads=0;
  const calls:string[]=[];
  const rows=Array.from({length:total},(_,i)=>({
    number:600+i,title:'Mock PR',state:'open',draft:true,
    head:{ref:'qa'+(600+i),sha:sha(600+i)},
    base:{ref:'main',sha:main}
  }));
  const api:GithubRead=async path=>{
    calls.push(path);
    const url=new URL(path,'https://api.github.com');
    if(url.pathname.endsWith('/branches/main'))return {commit:{sha:main}};
    if(url.pathname.endsWith('/pulls')){
      const page=Number(url.searchParams.get('page')??1);
      if(page===1)reads++;
      const copy=rows.map(x=>structuredClone(x));
      if(reads>=2&&opts.newOnSecondPass)
        copy.push({number:9999,title:'New',state:'open',draft:true,
          head:{ref:'qa9999',sha:sha(9999)},base:{ref:'main',sha:main}});
      if(reads>=2&&opts.changeHead)
        copy[0]!.head.sha='f'.repeat(40);
      return copy.slice((page-1)*100,page*100);
    }
    const files=url.pathname.match(/\/pulls\/(\d+)\/files$/);
    if(files){
      const pr=Number(files[1]),page=Number(url.searchParams.get('page')??1);
      if(page!==1)return [];
      if(opts.incompleteFiles&&pr===811)return [];
      const paths=[...(filesSpecial.get(pr)??[`docs/qa/generated-${pr}.md`])];
      if(opts.filesFlip&&pr===811&&reads>=3)paths.push('src/agent/different-owner.ts');
      return paths.map(filename=>({filename}));
    }
    if(url.pathname.endsWith('/actions/runs')){
      const head=url.searchParams.get('head_sha');
      const pr=Number.parseInt(head??'',16);
      const conclusion=opts.ciFlip&&pr===811&&reads>=3?'failure':
        ciSpecial.get(pr)??'success';
      const trueHead=opts.ciWrongSha&&pr===811?'f'.repeat(40):head;
      return {total_count:1,workflow_runs:[{id:3000000+pr,name:'CI',
        event:'pull_request',head_sha:trueHead,status:'completed',conclusion}]};
    }
    const comp=url.pathname.match(/\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})$/);
    if(comp){
      const pr=Number.parseInt(comp[2]??'',16);
      if(pr===708||opts.badCompare&&pr===811)
        return {status:'diverged',merge_base_commit:{sha:sha(12345)}};
      return {status:'ahead',merge_base_commit:{sha:comp[1]}};
    }
    throw new Error('UNEXPECTED_API_PATH:'+path);
  };
  return {api,calls};
}
test('QA24 two FULL 232-source passes reread HEAD/CI/files/merge-base with 100+100+32 paging',async()=>{
 const m=mock(232);
 const r=await collectQa24FullReview(m.api,'Naveax/Nexowire');
 assert.equal(r.full_source_passes,2);
 assert.equal(r.source.open_pr_count,232);
 assert.equal(r.source.nodes.length,232);
 assert.equal(r.source.open_prs_complete,true);
 assert.ok(r.source.nodes.every(n=>n.files_complete&&n.ci.run_head_sha===n.head_sha));
 const pullCalls=m.calls.filter(x=>x.includes('/pulls?state=open'));
 assert.deepEqual(pullCalls.map(x=>Number(new URL(x,'https://api.github.com').searchParams.get('page'))),
   [1,2,3,1,2,3,1,2,3,1,2,3]);
 assert.equal(m.calls.filter(x=>x.includes('/compare/')).length,464);
 assert.equal(m.calls.filter(x=>x.includes('/actions/runs?')).length,464);
 assert.equal(r.review.pr_count,232);
 assert.equal(r.review.production_merge_authorized,false);
 assert.deepEqual(r.review.current_safe_merge_queue,[]);
 assert.ok(r.review.issues.some(x=>x.code==='MERGE_BASE_STALE_OR_DIVERGED'&&x.prs.includes(708)));
 assert.ok(r.review.issues.some(x=>x.code==='MATERIAL_OWNER_PATH_OVERLAP'&&
   x.prs.includes(811)&&x.prs.includes(786)));
 assert.ok(r.review.issues.some(x=>x.code==='MATERIAL_OWNER_PATH_OVERLAP'&&
   x.prs.includes(811)&&x.prs.includes(800)));
 assert.ok(r.review.issues.some(x=>x.code==='MATERIAL_OWNER_PATH_OVERLAP'&&
   x.prs.includes(801)&&x.prs.includes(802)));
 assert.ok(r.review.issues.some(x=>x.code==='SOURCE_GREEN_NOT_ORIGINAL_NEGATIVE_PROOF'));
});

test('QA24 double-read prevents torn open set, new PR and SHA mutation',async()=>{
 await assert.rejects(collectQa24FullReview(mock(202,{newOnSecondPass:true}).api,
   'Naveax/Nexowire'),/SNAPSHOT_MOVED_DURING_COLLECTION/);
 await assert.rejects(collectQa24FullReview(mock(202,{changeHead:true}).api,
   'Naveax/Nexowire'),/SNAPSHOT_MOVED_DURING_COLLECTION/);
});

test('QA24 missing exact run, empty changed files and risky merge-base fail closed',async()=>{
 const missing=await collectQa24FullReview(mock(220,{ciWrongSha:true}).api,'Naveax/Nexowire');
 assert.ok(missing.review.issues.some(x=>x.code==='MISSING_EXACT_HEAD_PRIMARY_CI'&&x.prs.includes(811)));
 assert.ok(missing.review.issues.some(x=>x.code==='NON_GREEN_PRIMARY_CI'&&x.prs.includes(811)));
 assert.equal(missing.review.production_merge_authorized,false);
 const empty=await collectQa24FullReview(mock(220,{incompleteFiles:true}).api,
   'Naveax/Nexowire');
 assert.ok(empty.review.issues.some(x=>x.code==='INCOMPLETE_OWNER_FILES'&&x.prs.includes(811)));
 assert.deepEqual(empty.review.current_safe_merge_queue,[]);
 const risk=await collectQa24FullReview(mock(220,{badCompare:true}).api,'Naveax/Nexowire');
 assert.ok(risk.review.issues.some(x=>x.code==='MERGE_BASE_STALE_OR_DIVERGED'&&x.prs.includes(811)));
});

test('QA24 complete source-green still cannot authorize external CAS or native HIGH release',()=>{
 const m=mock(210);
 const {source}=await collectQa24FullReview(m.api,'Naveax/Nexowire');
 for(const n of source.nodes){
   n.ci.status='success';n.ci.conclusion='success';
   n.compare_status='ahead';n.merge_base_sha=n.base_sha;
 }
 const release=qa24ReleaseGate(source);
 assert.equal(release.gate,'NO_GO');
 assert.ok(release.issues.filter(x=>x.code==='PHYSICAL_RELEASE_WITNESS_MISSING').length>=4);
 assert.deepEqual(release.current_safe_merge_queue,[]);
});


test('QA24 two full passes reject changing CI/files at same HEAD without re-running CI',async()=>{
 await assert.rejects(collectQa24FullReview(mock(232,{ciFlip:true}).api,
   'Naveax/Nexowire'),/FULL_SOURCE_CI_FILES_COMPARE_MOVED_BETWEEN_PASSES/);
 await assert.rejects(collectQa24FullReview(mock(232,{filesFlip:true}).api,
   'Naveax/Nexowire'),/FULL_SOURCE_CI_FILES_COMPARE_MOVED_BETWEEN_PASSES/);
});
