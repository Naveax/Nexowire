import test from 'node:test';
import assert from 'node:assert/strict';
import {load774779,reconcile774779} from '../scripts/qa24-delta774-review.js';
import {partitionedOpenCensus,collect774779} from '../scripts/qa24-delta774-live.js';
import type {GithubRead} from '../scripts/qa24-live-dag.js';

const fresh=()=>structuredClone(load774779());
const one=(a:ReturnType<typeof load774779>['newDelta'],pr:number)=>{
  const n=a.find(z=>z.pr===pr);assert.ok(n,`Missing ${pr}`);return n;
};
test('QA24 160+15+6 overlays 179 IDs, P1 #780 is NOT an open P0 PR',()=>{
  const {graph,delta,newDelta,census}=fresh();
  const r=reconcile774779(graph,delta,newDelta,census);
  assert.equal(r.baseline_nodes,160);
  assert.equal(r.previous_delta_nodes,15);
  assert.equal(r.new_delta_nodes,6);
  assert.equal(r.known_nodes,179);
  assert.equal(r.captured_open_count,179);
  assert.equal(r.dag_edges,150);
  assert.equal(r.owner_collision_pairs,233);
  assert.equal(r.gate,'NO_GO');
  assert.equal(r.roadmap_issue_780.kind,'P1_PRODUCT_EPIC');
  assert.equal(r.roadmap_issue_780.mergeable_pr,false);
  assert.ok(!census.ids.includes(780));
  assert.equal(r.current_safe_merge_candidates.length,0);
});

test('QA24 red and missing CI are not manufactured into primary CI SUCCESS',()=>{
  const {graph,delta,newDelta,census}=fresh();
  const r=reconcile774779(graph,delta,newDelta,census);
  assert.deepEqual(r.delta_status.map(x=>x.pr),[774,775,776,777,778,779]);
  assert.equal(r.delta_status.find(x=>x.pr===774)?.primary_ci_conclusion,'success');
  assert.equal(r.delta_status.find(x=>x.pr===778)?.primary_ci_conclusion,'success');
  assert.equal(r.delta_status.find(x=>x.pr===777)?.primary_ci_conclusion,'failure');
  for(const pr of [775,776,779]){
    const x=r.delta_status.find(z=>z.pr===pr);assert.ok(x);
    assert.equal(x.primary_ci_run,null);assert.equal(x.primary_ci_conclusion,null);
    assert.ok(r.unverified_ci.some(z=>z.prs.includes(pr)));
  }
});

test('QA24 owner collisions #776 with #762 and #779 workflow are detected',()=>{
  const {graph,delta,newDelta,census}=fresh();
  const r=reconcile774779(graph,delta,newDelta,census);
  assert.ok(r.independent_delta_overlaps.some(x=>[x.a,x.b].includes(762)&&
    [x.a,x.b].includes(776)));
  assert.ok(r.independent_delta_overlaps.some(x=>[x.a,x.b].includes(779)&&
    x.files.includes('.github/workflows/ci.yml')));
  assert.ok(r.stale_parent.includes(609));
  assert.ok(r.stale_parent.includes(622));
  assert.ok(r.unresolved_parent.some(x=>x.prs.includes(776)));
});

test('QA24 #774 green descendant of unknown #768 remains blocked',()=>{
  const {graph,delta,newDelta,census}=fresh();
  const r=reconcile774779(graph,delta,newDelta,census);
  for(const pr of [774,777])assert.ok(
    r.red_or_stale_ancestor.some(x=>x.prs.includes(pr)),String(pr));
  assert.ok(!r.conditional_source_only_review.some(x=>[774,777,778].includes(x.pr)));
});

test('QA24 immutable SHAs, compare, files and owner ref checked',()=>{
  const {graph,delta,newDelta,census}=fresh();
  one(newDelta,775).head_sha='f'.repeat(40);
  one(newDelta,774).compare!.merge_base_sha='e'.repeat(40);
  one(newDelta,778).files_complete=false;
  one(newDelta,779).base_ref='';
  const r=reconcile774779(graph,delta,newDelta,census);
  for(const code of ['EXACT_HEAD_CI_MISMATCH','MISSING_OR_STALE_MERGE_BASE',
    'MISSING_CHANGED_FILE_PROOF','MISSING_HEAD_BASE_OR_PARENT'])
    assert.ok(r.failures.includes(code),code);
  assert.equal(r.conditional_source_only_review.length,0);
});

test('QA24 new PR arrival and duplicate delta prevent source-only shortlist',()=>{
  const {graph,delta,newDelta,census}=fresh();
  census.ids.push(781);
  census.segments.at(-1)!.ids.push(781);
  newDelta.push(structuredClone(one(newDelta,779)));
  const r=reconcile774779(graph,delta,newDelta,census);
  assert.ok(r.failures.includes('DELTA_774_779_MISSING_OR_DUPLICATED'));
  assert.ok(r.failures.includes('OPEN_SET_DRIFT'));
  assert.deepEqual(r.missingIds,[781]);
  assert.deepEqual(r.current_safe_merge_candidates,[]);
});

test('QA24 frozen conflict-free #657, #648 ranked for review only',()=>{
  const {graph,delta,newDelta,census}=fresh();
  const r=reconcile774779(graph,delta,newDelta,census);
  assert.deepEqual(r.conditional_source_only_review.map(x=>x.pr),[657,648]);
  assert.ok(r.conditional_source_only_review.every(
    x=>x.rank==='CONDITIONAL_SOURCE_REVIEW_ONLY'));
  assert.equal(r.live_freshness_verified,false);
  assert.equal(r.production_p0_merge_authorized,false);
});

function testApi(census:{segments:{query:string;ids:number[]}[]},
 nodes:ReturnType<typeof load774779>['newDelta'],options?:{
  moveOpenSet?:boolean;moveHead?:boolean;badCompare?:boolean;
}):GithubRead {
  let searchCount=0;
  const main='754cc4364822be5fda528f54042fb22a84f19924';
  const indexed=new Map(nodes.map(x=>[x.pr,x]));
  const perWindow=new Map(census.segments.map((s,i)=>[i,s.ids]));
  const win=(q:string)=>{
    if(q.includes('created:<2026-10-21'))return 0;
    if(q.includes('T00:00:00Z..2026-10-21T17:59:59Z'))return 1;
    if(q.includes('T18:00:00Z..2026-10-21T23:59:59Z'))return 2;
    if(q.includes('created:>=2026-10-22'))return 3;
    throw new Error('Unexpected window '+q);
  };
  const reads=new Map<number,number>();
  return async path=>{
    const url=new URL(path,'https://api.github.com');
    if(path.endsWith('/branches/main'))return {commit:{sha:main}};
    if(url.pathname==='/search/issues'){
      const bucket=win(url.searchParams.get('q')??'');
      const items=[...(perWindow.get(bucket)??[])];
      if(options?.moveOpenSet&&searchCount>=4&&bucket===3)items.push(781);
      searchCount++;
      const page=Number(url.searchParams.get('page')??1);
      return {total_count:items.length,items:items.slice((page-1)*100,page*100)
        .map(number=>({number,pull_request:{url:'https://example.invalid/pr'}}))};
    }
    const prPath=url.pathname.match(/\/pulls\/(\d+)(?:\/files)?$/);
    if(prPath) {
      const pr=Number(prPath[1]),n=indexed.get(pr);if(!n)throw new Error('Bad mock PR');
      if(url.pathname.endsWith('/files'))return n.files.map(filename=>({filename}));
      const seen=reads.get(pr)??0;reads.set(pr,seen+1);
      return {number:pr,state:'open',head:{sha:options?.moveHead&&seen>0&&pr===774?
        'f'.repeat(40):n.head_sha,ref:n.head_ref},
        base:{sha:n.base_sha,ref:n.base_ref}};
    }
    if(url.pathname.endsWith('/actions/runs')) {
      const n=nodes.find(x=>x.head_sha===url.searchParams.get('head_sha'));
      if(!n)throw new Error('Unrecognized SHA');
      const ci=n.ci;
      const runs=ci.run_id?[{id:ci.run_id,head_sha:n.head_sha,name:'CI',
        event:'pull_request',status:ci.status,conclusion:ci.conclusion}]:[];
      return {total_count:runs.length,workflow_runs:runs};
    }
    if(url.pathname.includes('/compare/')) {
      const match=url.pathname.match(/\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})$/);
      if(!match)throw new Error('Bad compare');
      const n=nodes.find(x=>x.base_sha===match[1]&&x.head_sha===match[2]);
      if(!n)throw new Error('Unknown compare');
      return {status:'ahead',merge_base_commit:{sha:options?.badCompare&&n.pr===774?
        'e'.repeat(40):n.base_sha}};
    }
    throw new Error('Unexpected mock API route '+path);
  };
}

test('QA24 live collector GET-only reads four partitions twice, targeted six only',async()=>{
  const {census,newDelta}=fresh();
  const result=await collect774779(testApi(census,newDelta),'Naveax/Nexowire');
  assert.equal(result.census.ids.length,179);
  assert.deepEqual(result.nodes.map(n=>n.pr),[774,775,776,777,778,779]);
  assert.equal(result.nodes.find(n=>n.pr===775)?.ci.run_id,null);
  assert.equal(result.nodes.find(n=>n.pr===774)?.ci.conclusion,'success');
  assert.equal(result.other_pr_heads_revalidated,false);
  assert.equal(result.production_merge_authorized,false);
});

test('QA24 partition query handles 101 results with 2 pages, no first-page cap',async()=>{
  const ids=Array.from({length:101},(_,i)=>1000+i);
  const api:GithubRead=async path=>{
    const url=new URL(path,'https://api.github.com');
    const page=Number(url.searchParams.get('page')??'1');
    return {total_count:101,items:ids.slice((page-1)*100,page*100)
      .map(number=>({number,pull_request:{url:'https://example.invalid'}}))};
  };
  const result=await partitionedOpenCensus(api,'Naveax/Nexowire',['created:>=2026-10-22']);
  assert.equal(result.ids.length,101);
  assert.equal(result.segments[0]?.ids.length,101);
});

test('QA24 truncated or moving pages and duplicate partition IDs fail closed',async()=>{
  const api:GithubRead=async()=>({total_count:1000,items:[]});
  await assert.rejects(partitionedOpenCensus(api,'Naveax/Nexowire'),/TRUNCATED/);
  const duplicate:GithubRead=async()=>({total_count:1,
    items:[{number:774,pull_request:{url:'x'}}]});
  await assert.rejects(partitionedOpenCensus(duplicate,'Naveax/Nexowire',['a','b']),
    /DUPLICATE/);
});

test('QA24 torn open set/head and mismatched compare cannot return live approval',async()=>{
  const {census,newDelta}=fresh();
  await assert.rejects(collect774779(testApi(census,newDelta,{moveOpenSet:true}),
    'Naveax/Nexowire'),/OPEN_SET_MOVED/);
  await assert.rejects(collect774779(testApi(census,newDelta,{moveHead:true}),
    'Naveax/Nexowire'),/PR_HEAD_MOVED/);
  const c=await collect774779(testApi(census,newDelta,{badCompare:true}),
    'Naveax/Nexowire');
  assert.notEqual(c.nodes.find(x=>x.pr===774)?.compare?.merge_base_sha,
    c.nodes.find(x=>x.pr===774)?.base_sha);
  assert.equal(c.production_merge_authorized,false);
});
