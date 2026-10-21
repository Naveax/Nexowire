import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  auditLiveSnapshot,collectLiveSnapshot,parseExactCi,githubRestRead,
  type LiveSnapshot,type LiveNode,type OldSnapshot,type GithubRead,
} from '../scripts/qa24-live-dag.js';

const A='a'.repeat(40), B='b'.repeat(40), C='c'.repeat(40), D='d'.repeat(40), E='e'.repeat(40);
const baseNode=(pr:number,head_sha:string,base_sha:string,parent_pr:number|null,
  files:string[],ciStatus:'success'|'failure'|'unknown'|'pending'='success'):LiveNode=>({
  pr,title:'synthetic QA PR',head_ref:`b${pr}`,head_sha,base_ref:parent_pr===null?'main':`b${parent_pr}`,
  base_sha,parent_pr,draft:true,files,files_complete:true,
  ci:{status:ciStatus,run_id:ciStatus==='unknown'?null:pr,
    run_head_sha:ciStatus==='unknown'?null:head_sha,workflow_status:
      ciStatus==='pending'?'in_progress':'completed',conclusion:
      ciStatus==='success'?'success':ciStatus==='failure'?'failure':null},
  merge_base_sha:base_sha,compare_status:'ahead',
});
const sample=():LiveSnapshot=>({
  schema_version:2,repository:'Naveax/Nexowire',observed_at:'2026-10-21T16:00:00.000Z',
  main_head:A,source:'github-rest-readonly',open_pr_count:3,open_prs_complete:true,
  nodes:[baseNode(100,B,A,null,['src/helper.ts']),
    baseNode(101,C,B,100,['src/helper.ts']),
    baseNode(102,D,A,null,['src/helper.ts'],'failure')],errors:[],
});
const old=():OldSnapshot=>({main_head:A,nodes:[{
  pr:100,head_sha:B,base_sha:A,parent_pr:null,
  ci:{run_id:100,status:'completed',conclusion:'success'}}]});
const codes=(s:LiveSnapshot,o:OldSnapshot|LiveSnapshot=old())=>
  auditLiveSnapshot(o,s).findings.map(f=>f.code);


test('QA24 pinned repository evidence proves 38->50->67 open-set drift without network',()=>{
  const parsed=(rel:string)=>JSON.parse(readFileSync(new URL(rel,import.meta.url),'utf8')) as {
    nodes:Array<{pr:number;head_sha:string;parent_pr:number|null;ci:{run_id:number;conclusion:string|null}}>;
    open_pr_count?:number;
  };
  const older=parsed('../docs/qa/p0-integration-dag-20261021.json');
  const intermediate=parsed('../docs/qa/p0-integration-dag-open50-20261021.json');
  const latest=parsed('../docs/qa/p0-integration-dag-open67-20261021.json');
  assert.equal(older.nodes.length,38);
  assert.equal(intermediate.nodes.length,50);
  assert.equal(latest.nodes.length,67);
  assert.equal(latest.nodes.filter(n=>n.parent_pr!==null).length,41);
  assert.equal(latest.nodes.some(n=>n.pr===630),false);
  assert.ok(latest.nodes.some(n=>n.pr===664&&n.ci.conclusion===null));
  const baseline=new Set(older.nodes.map(n=>n.pr));
  assert.equal(latest.nodes.filter(n=>!baseline.has(n.pr)).length,29);
  assert.notEqual(latest.nodes.find(n=>n.pr===643)?.ci.conclusion,
    intermediate.nodes.find(n=>n.pr===643)?.ci.conclusion);
  assert.equal(latest.nodes.find(n=>n.pr===646)?.ci.conclusion,'failure');
});

test('QA24 stale 38->50 pattern: any newly opened PR blocks old snapshot',()=>{
  const s=sample(),report=auditLiveSnapshot(old(),s);
  assert.equal(report.open_pr_count,3);
  assert.ok(report.findings.some(f=>f.code==='NEW_OPEN_PR'&&f.prs[0]===101));
  assert.ok(report.findings.some(f=>f.code==='NEW_OPEN_PR'&&f.prs[0]===102));
  assert.ok(codes(s).includes('STALE_SNAPSHOT'));
  assert.equal(report.gate,'NO_GO');
});

test('QA24 same-SHA CI lifecycle transition invalidates cached result',()=>{
  const s=sample();const cached=old();
  cached.nodes[0]!.ci!.status='in_progress';
  cached.nodes[0]!.ci!.conclusion=null;
  assert.ok(codes(s,cached).includes('CI_STATE_CHANGED'));
  assert.ok(codes(s,cached).includes('STALE_SNAPSHOT'));
});

test('QA24 false green from old SHA cannot pass a new SHA',()=>{
  const s=sample();s.nodes[0]!.head_sha=E;
  assert.ok(codes(s).includes('HEAD_MOVED'));
  assert.ok(codes(s).includes('CI_UNVERIFIED_SHA'));
  assert.equal(auditLiveSnapshot(old(),s).gate,'NO_GO');
});

test('QA24 exact HEAD CI requires CI workflow, matching head, terminal result',()=>{
  const fake=(head:string,event='pull_request',name='CI',status='completed',conclusion='success',id=3)=>
    ({id,head_sha:head,event,name,status,conclusion});
  assert.equal(parseExactCi(B,{workflow_runs:[fake(A)],total_count:1}).status,'unknown');
  assert.equal(parseExactCi(B,{workflow_runs:[fake(B,'pull_request','Release Readiness')],total_count:1}).status,'unknown');
  assert.equal(parseExactCi(B,{workflow_runs:[fake(B,'pull_request','CI','in_progress','')],total_count:1}).status,'pending');
  assert.equal(parseExactCi(B,{workflow_runs:[fake(B,'pull_request','CI','completed','failure')],total_count:1}).status,'failure');
  assert.equal(parseExactCi(B,{workflow_runs:[fake(B,'pull_request','CI','completed','success')],total_count:1}).status,'success');
  assert.equal(parseExactCi(B,{workflow_runs:[fake(B,'pull_request','CI','completed','success')],total_count:999}).status,'unknown');
  assert.equal(parseExactCi(B,{workflow_runs:[fake(B,'push')],total_count:1}).status,'unknown');
  assert.equal(parseExactCi(B,{workflow_runs:[fake(B,'pull_request','CI','completed','success',1),
    fake(B,'pull_request','CI','queued','',2)],total_count:2}).status,'pending');
});

test('QA24 child green does not override red parent or stale parent base',()=>{
  const s=sample();
  s.nodes[0]!.ci.status='failure';
  s.nodes[1]!.base_sha=E;
  assert.ok(codes(s).includes('PARENT_CI_NOT_GREEN'));
  assert.ok(codes(s).includes('STALE_PARENT'));
  assert.ok(codes(s).includes('MERGE_BASE_RISK'));
});

test('QA24 independent writer collision is reported; stacked changes are not',()=>{
  const s=sample(),result=auditLiveSnapshot(old(),s);
  const overlaps=result.findings.filter(f=>f.code==='OWNER_COLLISION');
  assert.ok(overlaps.some(f=>f.prs.includes(100)&&f.prs.includes(102)));
  assert.ok(overlaps.some(f=>f.prs.includes(101)&&f.prs.includes(102)));
  assert.equal(overlaps.some(f=>f.prs.includes(100)&&f.prs.includes(101)),false);
});

test('QA24 missing files, unresolved parent, missing compare and pending CI are NO-GO',()=>{
  const s=sample();
  const node=s.nodes[1]!;
  node.base_ref='missing-owner-branch';node.parent_pr=null;node.files_complete=false;
  node.merge_base_sha=null;node.compare_status=null;node.ci.status='pending';
  for(const c of ['INCOMPLETE_FILE_LIST','UNRESOLVED_PARENT','MERGE_BASE_UNKNOWN','CI_NOT_GREEN'])
    assert.ok(codes(s).includes(c),c);
});

test('QA24 moved/closed PR is not automatically called merged',()=>{
  const s=sample();s.nodes.shift();s.open_pr_count=2;
  assert.ok(codes(s).includes('NO_LONGER_OPEN'));
  assert.equal(codes(s).includes('MERGED'),false);
});

const rawPr=(n:number,h:string,b:string,bref='main')=>({
  number:n,title:'fixture',draft:true,head:{ref:`b${n}`,sha:h},base:{ref:bref,sha:b},
});
const githubFixture=(mutateAtSecondList=false):GithubRead=>{
  let prLists=0;
  const prs=[rawPr(100,B,A),rawPr(101,C,B,'b100')];
  return async path=>{
    if(path==='/repos/Naveax/Nexowire/branches/main')return {commit:{sha:A}};
    if(path.startsWith('/repos/Naveax/Nexowire/pulls?state=open')){
      prLists++;
      const page=Number(new URL('https://x.invalid'+path).searchParams.get('page'));
      if(page!==1)return [];
      if(mutateAtSecondList&&prLists===2)return [rawPr(100,E,A),prs[1]];
      return prs;
    }
    const matched=path.match(/\/pulls\/(\d+)\/files/);
    if(matched)return [{filename:matched[1]==='100'?'src/common.ts':'test/other.ts'}];
    const ci=path.match(/head_sha=([a-f0-9]{40})/);
    if(ci)return {total_count:1,workflow_runs:[{
      id:100,head_sha:ci[1],event:'pull_request',name:'CI',
      status:'completed',conclusion:'success',
    }]};
    const cmp=path.match(/\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})/);
    if(cmp)return {status:'ahead',merge_base_commit:{sha:cmp[1]}};
    throw new Error('UNEXPECTED_MOCK_PATH:'+path);
  };
};

test('QA24 live collector paginates and independently pins current owner/child ancestry',async()=>{
  const snapshot=await collectLiveSnapshot(githubFixture(), 'Naveax/Nexowire',
    '2026-10-21T16:00:00.000Z');
  assert.equal(snapshot.open_pr_count,2);
  assert.equal(snapshot.nodes[1]?.parent_pr,100);
  assert.equal(snapshot.nodes[1]?.base_sha,B);
  assert.equal(snapshot.nodes[1]?.ci.run_head_sha,C);
  assert.equal(snapshot.open_prs_complete,true);
  assert.equal(snapshot.source,'github-rest-readonly');
});

test('QA24 torn read with changed head is rejected, never serialized green',async()=>{
  await assert.rejects(collectLiveSnapshot(githubFixture(true),'Naveax/Nexowire'),
    /SNAPSHOT_MOVED_DURING_COLLECTION/);
});

test('QA24 partial API failure cannot return partial success',async()=>{
  const api:GithubRead=async path=>{
    if(path.endsWith('/branches/main'))return {commit:{sha:A}};
    if(path.includes('/pulls?state=open'))return [rawPr(100,B,A)];
    if(path.includes('/pulls/100/files'))throw new Error('HTTP 503');
    throw new Error('unexpected');
  };
  await assert.rejects(collectLiveSnapshot(api,'Naveax/Nexowire'),/HTTP 503/);
});

test('QA24 credential required and repository IDs constrained',async()=>{
  assert.throws(()=>githubRestRead(''),/GITHUB_TOKEN_REQUIRED/);
  await assert.rejects(collectLiveSnapshot(githubFixture(),'../other'),/INVALID_REPO/);
});
