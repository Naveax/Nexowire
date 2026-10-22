import test from 'node:test';
import assert from 'node:assert/strict';
import {collectOpenPrIntegration,type GithubRead} from '../scripts/qa44-open-pr-integration.js';
const SHA=(n:number)=>n.toString(16).padStart(40,'0');
type Seed={n:number;h:string;b:string;ref:string;baseRef:string;files:string[];ci?:string;merge?:string;workflow?:number;attempt?:number;active?:boolean;};
function seed(n:number,baseRef='main',b=SHA(1),files=[`src/owner-${n}.ts`]):Seed{
 return {n,h:SHA(n+300),b,ref:`branch-${n}`,baseRef,files,ci:'success',merge:b};
}
function fixture(options?:{extra?:boolean;changeHead?:boolean;changeCi?:boolean;incompleteFiles?:boolean;staleMain?:boolean;duplicateFile?:boolean}){
 const p1=seed(1,'main',options?.staleMain?SHA(99):SHA(1),['src/shared.ts']);
 const p2=seed(2,'branch-1',p1.h,['src/shared.ts']);
 const p3=seed(3,'main',SHA(1),['src/shared.ts']);
 const old=[p1,p2,p3];
 // 205 open PRs require three pages. Only three selected PRs need detail evidence.
 const others=Array.from({length:202},(_,i)=>seed(1000+i));
 const all=[...old,...others].sort((a,b)=>b.n-a.n);
 const requests:string[]=[];let actionCalls=new Map<string,number>();let censusPageOne=0;
 const api:GithubRead=async path=>{
  requests.push(path);
  const u=new URL(path,'https://api.github.com');
  if(u.pathname.endsWith('/git/ref/heads/main'))return {object:{sha:SHA(1)}};
  if(u.pathname.endsWith('/pulls')){
   const page=Number(u.searchParams.get('page'));
   if(page===1)censusPageOne++;
   const list=[...all];
   if(censusPageOne>=2&&options?.extra)list.push(seed(2000));
   if(censusPageOne>=2&&options?.changeHead)list.find(x=>x.n===2)!.h=SHA(9000);
   return list.slice((page-1)*100,page*100).map(p=>({number:p.n,state:'open',head:{sha:p.h,ref:p.ref},
    base:{sha:p.b,ref:p.baseRef},labels:[]}));
  }
  const one=u.pathname.match(/\/pulls\/(\d+)$/);
  if(one){const p=old.find(x=>x.n===Number(one[1]));if(!p)throw Error('EXTRA_PR_DETAIL');
   return {number:p.n,state:'open',head:{sha:p.h,ref:p.ref},base:{sha:p.b,ref:p.baseRef},changed_files:options?.duplicateFile&&p.n===2?2:p.files.length};}
  const files=u.pathname.match(/\/pulls\/(\d+)\/files$/);
  if(files){const p=old.find(x=>x.n===Number(files[1]));if(!p)throw Error('EXTRA_FILES');
   if(options?.incompleteFiles&&p.n===2)return [];
   if(options?.duplicateFile&&p.n===2){if(Number(u.searchParams.get('page'))===1)return [{filename:'src/a.ts'},{filename:'src/a.ts'}];return [];}
   const page=Number(u.searchParams.get('page'));
   return p.files.slice((page-1)*100,page*100).map(filename=>({filename}));}
  if(u.pathname.includes('/compare/')){
   const id=old.find(x=>u.pathname.endsWith(`/compare/${x.b}...${x.h}`));
   if(!id)throw Error('EXTRA_COMPARE');
   return {status:'ahead',merge_base_commit:{sha:id.merge}};}
  if(u.pathname.endsWith('/actions/runs')){
   const h=u.searchParams.get('head_sha')||'';
   const p=old.find(x=>x.h===h);if(!p)throw Error('EXTRA_ACTION');
   const k=p.ref;const calls=(actionCalls.get(k)||0)+1;actionCalls.set(k,calls);
   const changed=options?.changeCi&&p.n===2&&calls>1;
   const runs=[{id:p.n+500,workflow_id:12,name:'CI',run_attempt:changed?2:p.attempt||1,
    event:'pull_request',head_sha:p.h,status:changed?'in_progress':p.active?'in_progress':'completed',
    conclusion:changed||p.active?null:p.ci}];
   if(p.workflow===2)runs.push({id:p.n+600,workflow_id:12,name:'CI',run_attempt:1,
    event:'pull_request',head_sha:p.h,status:'queued',conclusion:null});
   return {total_count:runs.length,workflow_runs:runs.slice((Number(u.searchParams.get('page'))-1)*100,Number(u.searchParams.get('page'))*100)};
  }
  throw Error('UNEXPECTED_GET '+path);
 };
 return {api,old,requests};
}
test('QA44 live-style 205 all-open REST list is paginated twice, scoped files/CI/merge base are pinned; never authorize merge',async()=>{
 const f=fixture(),r=await collectOpenPrIntegration(f.api,'Naveax/Nexowire',[1,2,3]);
 assert.equal(r.open_count,205);assert.equal(r.open_refs_double_read,true);
 assert.equal(r.critical_scope_complete_for_selected,true);assert.equal(r.all_open_detailed_ci_verified,false);
 assert.equal(r.gate,'NO_GO');assert.equal(r.production_merge_authorized,false);
 assert.deepEqual(r.safe_merge_queue,[]);
 const pages=f.requests.filter(p=>p.includes('/pulls?state=open')).map(p=>Number(new URL(p,'https://api.github.com').searchParams.get('page')));
 assert.deepEqual(pages,[1,2,3,1,2,3]);
 assert.ok(r.blockers.some(x=>x.reason==='INDEPENDENT_FILE_COLLISION'&&x.related_pr===3));
 assert.ok(!r.blockers.some(x=>x.reason==='INDEPENDENT_FILE_COLLISION'&&x.related_pr===2));
 assert.equal(f.requests.filter(p=>p.includes('/actions/runs')).length,6);
});
test('QA44 stale parent and red ancestor block descendant even when own exact CI is green',async()=>{
 const f=fixture();f.old[0]!.h=SHA(321);f.old[1]!.ci='success';f.old[0]!.ci='failure';
 const r=await collectOpenPrIntegration(f.api,'Naveax/Nexowire',[2]);
 assert.ok(r.blockers.some(x=>x.pr===2&&x.reason==='STALE_PARENT_SHA'));
 assert.ok(r.blockers.some(x=>x.pr===2&&x.reason==='RED_OR_UNKNOWN_ANCESTOR'));
});
test('QA44 two-pass torn count or HEAD rejects snapshot instead of returning provisional merge list',async()=>{
 await assert.rejects(collectOpenPrIntegration(fixture({extra:true}).api,'Naveax/Nexowire',[1]),/TORN_OPEN_PR_CENSUS/);
 await assert.rejects(collectOpenPrIntegration(fixture({changeHead:true}).api,'Naveax/Nexowire',[1,2]),/TORN_OPEN_PR_CENSUS/);
});
test('QA44 missing changed-file page rejects evidence and cannot silently ignore collisions',async()=>{
 await assert.rejects(collectOpenPrIntegration(fixture({incompleteFiles:true}).api,'Naveax/Nexowire',[2]),/INCOMPLETE_FILE_PAGINATION_2/);
});
test('QA44 rerun underway and competing workflow both block, while source success is never merge approval',async()=>{
 const f=fixture();f.old[0]!.active=true;f.old[0]!.attempt=2;f.old[2]!.workflow=2;f.old[2]!.active=true;
 const r=await collectOpenPrIntegration(f.api,'Naveax/Nexowire',[1,2,3]);
 assert.ok(r.blockers.some(x=>x.reason==='WORKFLOW_RERUN_IN_PROGRESS'));
 assert.ok(r.blockers.some(x=>x.reason==='CONCURRENT_WORKFLOW_RUNS'));
 assert.deepEqual(r.safe_merge_queue,[]);
});
test('QA44 Actions run-attempt drifts after census so exact-CI witness invalidates',async()=>{
 const r=await collectOpenPrIntegration(fixture({changeCi:true}).api,'Naveax/Nexowire',[1,2]);
 assert.ok(r.blockers.some(x=>x.pr===2&&x.reason==='CI_CHANGED_DURING_COLLECTION'));
});
test('QA44 divergent merge base and stale main are independent blockers',async()=>{
 const f=fixture({staleMain:true});f.old[2]!.merge=SHA(200);
 const r=await collectOpenPrIntegration(f.api,'Naveax/Nexowire',[1,3]);
 assert.ok(r.blockers.some(x=>x.pr===1&&x.reason==='STALE_MAIN_BASE_SHA'));
 assert.ok(r.blockers.some(x=>x.pr===3&&x.reason==='DIVERGED_OR_STALE_MERGE_BASE'));
});

test('QA44 duplicated changed filename is rejected, not silently deduplicated',async()=>{
 await assert.rejects(collectOpenPrIntegration(fixture({duplicateFile:true}).api,'Naveax/Nexowire',[2]),/DUPLICATE_CHANGED_FILENAME_2/);
});
