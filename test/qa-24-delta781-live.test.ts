import test from 'node:test';
import assert from 'node:assert/strict';
import {readAllOpenRefs,collect781790Live} from '../scripts/qa24-delta781-live.js';
import {load781790} from '../scripts/qa24-delta781-review.js';
import type {GithubRead} from '../scripts/qa24-live-dag.js';

const SHA='754cc4364822be5fda528f54042fb22a84f19924';
const fake=(num:number)=>({number:num,state:'open',
  head:{sha:num.toString(16).padStart(40,'0'),ref:`pr-${num}`},
  base:{sha:SHA,ref:'main'}});
const fixture=()=>structuredClone(load781790().ten);

test('QA24 true GitHub GET /pulls 100+89+empty pages, not first-page 100',async()=>{
  const pages:number[]=[];
  const api:GithubRead=async path=>{
    const u=new URL(path,'https://api.github.com');
    const page=Number(u.searchParams.get('page')??'0');
    pages.push(page);
    return Array.from({length:189},(_,i)=>fake(i+1)).slice((page-1)*100,page*100);
  };
  const refs=await readAllOpenRefs(api,'Naveax/Nexowire');
  assert.equal(refs.length,189);
  assert.deepEqual(pages,[1,2,3]);
  assert.equal(refs[188]?.pr,189);
});

test('QA24 duplicate and moving partial pages fail closed',async()=>{
  const duplicate:GithubRead=async path=>{
    const page=Number(new URL(path,'https://api.github.com').searchParams.get('page'));
    if(page===1)return Array.from({length:100},(_,i)=>fake(i+1));
    if(page===2)return [fake(100)];
    return [];
  };
  await assert.rejects(readAllOpenRefs(duplicate,'Naveax/Nexowire'),/DUPLICATE/);
  const torn:GithubRead=async path=>{
    const page=Number(new URL(path,'https://api.github.com').searchParams.get('page'));
    if(page===1)return [fake(1)];
    if(page===2)return [fake(2)];
    return [];
  };
  await assert.rejects(readAllOpenRefs(torn,'Naveax/Nexowire'),/NONTERMINAL_SHORT/);
});

function mockedLive(nodes:ReturnType<typeof fixture>,opts?:{
  moved?:boolean;missingCi?:boolean;compareRisk?:boolean;added?:boolean;
}):GithubRead{
  const readCount=new Map<number,number>();
  const byHead=new Map(nodes.map(n=>[n.head_sha,n]));
  const baseRows=nodes.map(n=>({number:n.pr,state:'open',
    head:{sha:n.head_sha,ref:n.head_ref},base:{sha:n.base_sha,ref:n.base_ref}}));
  let openRounds=0;
  return async path=>{
    const url=new URL(path,'https://api.github.com');
    if(url.pathname.endsWith('/branches/main'))return {commit:{sha:SHA}};
    if(url.pathname.endsWith('/pulls')){
      const page=Number(url.searchParams.get('page'));
      if(page===1){
        openRounds++;
        const rows=baseRows.map(x=>structuredClone(x));
        if(opts?.moved&&openRounds>1)rows[0]!.head.sha='f'.repeat(40);
        if(opts?.added&&openRounds>1)rows.push(fake(799));
        return rows;
      }
      return [];
    }
    const m=url.pathname.match(/\/pulls\/(\d+)\/files$/);
    if(m) {
      const pr=Number(m[1]),n=nodes.find(x=>x.pr===pr);
      if(!n)throw Error('Unexpected file PR');
      const pg=Number(url.searchParams.get('page'));
      return pg===1?n.files.map(filename=>({filename})):[];
    }
    if(url.pathname.endsWith('/actions/runs')){
      const n=byHead.get(url.searchParams.get('head_sha')??'');
      if(!n)throw Error('Bad SHA');
      const runs=opts?.missingCi&&n.pr===781?[]:n.ci.run_id?[{
        id:n.ci.run_id,head_sha:n.head_sha,name:'CI',event:'pull_request',
        status:n.ci.status,conclusion:n.ci.conclusion}]:[];
      return {total_count:runs.length,workflow_runs:runs};
    }
    if(url.pathname.includes('/compare/')){
      const m=url.pathname.match(/\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})$/);
      if(!m)throw Error('Unexpected compare');
      const n=nodes.find(x=>x.head_sha===m[2]&&x.base_sha===m[1]);
      if(!n)throw Error('Missing compare');
      return {status:'ahead',merge_base_commit:{sha:opts?.compareRisk&&n.pr===781?
        'e'.repeat(40):n.base_sha}};
    }
    throw Error('Unexpected GET '+path);
  };
}

test('QA24 targeted ten-only read verifies all open refs twice but NEVER merges',async()=>{
  const res=await collect781790Live(mockedLive(fixture()),'Naveax/Nexowire');
  assert.equal(res.observed_open_count,10);
  assert.deepEqual(res.inspected_details,[781,782,783,784,785,786,787,788,789,790]);
  assert.equal(res.nodes.find(x=>x.pr===789)?.ci.conclusion,'success');
  assert.equal(res.nodes.find(x=>x.pr===786)?.ci.conclusion,'failure');
  assert.equal(res.nodes.find(x=>x.pr===782)?.ci.conclusion,null);
  assert.equal(res.other_open_file_ci_not_refreshed,true);
  assert.equal(res.production_merge_authorized,false);
  assert.deepEqual(res.current_safe_merge_candidates,[]);
});

test('QA24 new/changed open refs fail closed even when target CI is green',async()=>{
  await assert.rejects(collect781790Live(mockedLive(fixture(),{moved:true}),
    'Naveax/Nexowire'),/OPEN_REFS_OR_MAIN_MOVED/);
  await assert.rejects(collect781790Live(mockedLive(fixture(),{added:true}),
    'Naveax/Nexowire'),/OPEN_REFS_OR_MAIN_MOVED/);
});

test('QA24 bad merge-base fails; missing exact CI remains UNKNOWN, not green',async()=>{
  await assert.rejects(collect781790Live(mockedLive(fixture(),{compareRisk:true}),
    'Naveax/Nexowire'),/BAD_MERGE_BASE_781/);
  const res=await collect781790Live(mockedLive(fixture(),{missingCi:true}),
    'Naveax/Nexowire');
  const n=res.nodes.find(x=>x.pr===781);
  assert.equal(n?.ci.run_id,null);
  assert.equal(n?.ci.conclusion,null);
  assert.equal(res.production_merge_authorized,false);
});
