import test from 'node:test';
import assert from 'node:assert/strict';
import {collect791803Live} from '../scripts/qa24-delta791-live.js';
import {load791803} from '../scripts/qa24-delta791-review.js';
import type {GithubRead} from '../scripts/qa24-live-dag.js';

const fixture=()=>structuredClone(load791803());
const baselineSha='754cc4364822be5fda528f54042fb22a84f19924';
function mock(opts?:{moveHead?:boolean;moreOpen?:boolean;loseCi?:boolean;loseFiles?:boolean}) {
 const {new13,changed}=fixture();
 const selected=[...changed,...new13];
 const open=[...selected.map(n=>({number:n.pr,state:'open',
   head:{sha:n.head_sha,ref:n.head_ref},base:{sha:n.base_sha,ref:n.base_ref}})),
   ...Array.from({length:187},(_,i)=>({number:10000+i,state:'open',
     head:{sha:(10000+i).toString(16).padStart(40,'0'),ref:'mock-'+i},
     base:{sha:baselineSha,ref:'main'}}))];
 open.sort((a,b)=>a.number-b.number);
 let pass=0;
 const requests:string[]=[];
 const api:GithubRead=async path=>{
   requests.push(path);
   const u=new URL(path,'https://api.github.com');
   if(u.pathname.endsWith('/branches/main'))return {commit:{sha:baselineSha}};
   if(u.pathname.endsWith('/pulls')){
     const page=Number(u.searchParams.get('page'));
     const result=open.map(x=>structuredClone(x));
     if(pass>=4&&opts?.moreOpen)result.push({number:20000,state:'open',
       head:{sha:'a'.repeat(40),ref:'extra'},base:{sha:baselineSha,ref:'main'}});
     if(pass>=4&&opts?.moveHead){
       const n=result.find(x=>x.number===803);if(n)n.head.sha='b'.repeat(40);
     }
     pass++;
     return result.slice((page-1)*100,page*100);
   }
   const files=u.pathname.match(/\/pulls\/(\d+)\/files$/);
   if(files){
     const pr=Number(files[1]),x=selected.find(n=>n.pr===pr);
     if(!x)throw Error('UNEXPECTED_OWNER_FILES');
     if(opts?.loseFiles&&pr===793)return [];
     return Number(u.searchParams.get('page'))===1?x.files.map(filename=>({filename})):[];
   }
   if(u.pathname.endsWith('/actions/runs')){
     const head=u.searchParams.get('head_sha');
     const x=selected.find(n=>n.head_sha===head);
     if(!x)throw Error('UNEXPECTED_CI_HEAD');
     const runs=opts?.loseCi&&x.pr===793?[]:x.ci.run_id?[{
       id:x.ci.run_id,name:'CI',event:'pull_request',head_sha:x.head_sha,
       status:x.ci.status,conclusion:x.ci.conclusion}]:[];
     return {total_count:runs.length,workflow_runs:runs};
   }
   if(u.pathname.includes('/compare/')){
     const m=u.pathname.match(/\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/);
     if(!m)throw Error('BAD_COMPARE_REQUEST');
     const x=selected.find(n=>n.base_sha===m[1]&&n.head_sha===m[2]);
     if(!x)throw Error('WRONG_MERGE_BASE');
     return {merge_base_commit:{sha:x.compare!.merge_base_sha},status:x.compare!.status};
   }
   throw Error('UNEXPECTED_GET:'+path);
 };
 return {api,requests};
}

test('QA24 202 HEAD refs: GET pages 100+100+2+empty twice, only fifteen details',async()=>{
 const {api,requests}=mock();
 const res=await collect791803Live(api,'Naveax/Nexowire');
 assert.equal(res.open_count_at_double_read,202);
 assert.equal(res.delta.length,15);
 assert.equal(res.all_open_refs_double_read,true);
 assert.equal(res.all_open_ci_and_files_verified,false);
 assert.deepEqual(res.current_safe_merge_candidates,[]);
 assert.equal(res.production_merge_authorized,false);
 const getPages=requests.filter(x=>x.includes('/pulls?state=open'));
 assert.equal(getPages.length,8);
 assert.deepEqual(getPages.map(x=>Number(new URL(x,'https://api.github.com').searchParams.get('page'))),
   [1,2,3,4,1,2,3,4]);
});

test('QA24 708 divergent merge-base and 726 red are retained, 803 green not merge-safe',async()=>{
 const {api}=mock();const r=await collect791803Live(api,'Naveax/Nexowire');
 assert.ok(r.blocked.some(x=>x.pr===708&&x.compare==='diverged'));
 assert.ok(r.blocked.some(x=>x.pr===726&&x.ci==='failure'));
 assert.ok(r.blocked.some(x=>x.pr===800&&x.ci==='failure'));
 assert.ok(!r.blocked.some(x=>x.pr===803));
 assert.equal(r.production_merge_authorized,false);
});

test('QA24 different open PR HEAD or new PR during second pass fail close',async()=>{
 await assert.rejects(collect791803Live(mock({moveHead:true}).api,'Naveax/Nexowire'),
   /TORN_OPEN_PR_HEAD_OR_MAIN/);
 await assert.rejects(collect791803Live(mock({moreOpen:true}).api,'Naveax/Nexowire'),
   /TORN_OPEN_PR_HEAD_OR_MAIN/);
});

test('QA24 failed path pagination denies evidence; missing exact CI remains unknown',async()=>{
 await assert.rejects(collect791803Live(mock({loseFiles:true}).api,'Naveax/Nexowire'),
   /INCOMPLETE_CHANGED_FILES_793/);
 const r=await collect791803Live(mock({loseCi:true}).api,'Naveax/Nexowire');
 assert.ok(r.blocked.some(x=>x.pr===793&&x.ci==='unknown'));
 assert.equal(r.delta.find(n=>n.pr===793)?.ci.run_id,null);
 assert.equal(r.delta.find(n=>n.pr===793)?.ci.conclusion,null);
});
