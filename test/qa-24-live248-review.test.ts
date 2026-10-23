import test from 'node:test';
import assert from 'node:assert/strict';
import {loadLive248Evidence,reviewLive248Evidence} from '../scripts/qa24-live248-review.js';

const fresh=()=>structuredClone(loadLive248Evidence());
const rec=(x:ReturnType<typeof fresh>,pr:number)=>{
 const r=x.records.find(n=>n.pr===pr);assert.ok(r,`No exact record #${pr}`);return r;
};
const has=(a:ReturnType<typeof reviewLive248Evidence>,code:string,pr?:number)=>
 a.issues.some(x=>x.code===code&&(pr===undefined||x.prs.includes(pr)));

test('QA24 REST two-pass 100+100+48+empty gave 248 current HEAD/base, not 248 CI proofs',()=>{
 const r=reviewLive248Evidence(fresh());
 assert.equal(r.authoritative_refs_two_pass,true);
 assert.equal(r.open_count,248);
 assert.equal(r.edge_count,201);
 assert.equal(r.stale_parent_count,13);
 assert.equal(r.unresolved_parents.length,2);
 assert.deepEqual(r.unresolved_parents.map(x=>x.pr),[776,849]);
 assert.equal(r.detailed_exact_head_count,16);
 assert.equal(r.missing_detailed_count,232);
 assert.equal(r.gate,'NO_GO');
 assert.deepEqual(r.current_safe_merge_queue,[]);
 assert.equal(r.production_merge_authorized,false);
 assert.ok(has(r,'FULL_EXACT_CI_FILES_COMPARE_NOT_VERIFIED'));
});

test('QA24 811 current SHA CI red and 826 direct task graph red, no inherited old success',()=>{
 const a=reviewLive248Evidence(fresh());
 for(const pr of [811,826]){
  assert.ok(has(a,'CRITICAL_MAIN_CI_NOT_GREEN',pr));
  assert.equal(a.critical_ci.find(n=>n.pr===pr)?.conclusion,'failure');
 }
 assert.equal(a.critical_ci.find(n=>n.pr===811)?.head,
  'daa166e42f94fa1529b48c293a51c58b1c2384e7');
 assert.equal(a.critical_ci.find(n=>n.pr===811)?.run,39939395440);
 assert.equal(a.critical_ci.find(n=>n.pr===826)?.run,39938851608);
});

test('QA24 old-base #845 #821 #814 red, blocked under latest parent HEAD',()=>{
 const r=reviewLive248Evidence(fresh());
 for(const pr of [845,821,814]){
  assert.ok(has(r,'STALE_STACKED_PARENT_SHA',pr));
  assert.ok(has(r,'CRITICAL_MAIN_CI_NOT_GREEN',pr));
  assert.ok(r.critical_red_ancestor_edges.some(x=>x.pr===pr&&x.parent===811));
 }
});

test('QA24 #708 diverged and red; #726 red, #829 source success only',()=>{
 const r=reviewLive248Evidence(fresh());
 assert.ok(has(r,'CRITICAL_MERGE_BASE_NOT_PROVEN',708));
 assert.ok(has(r,'CRITICAL_MAIN_CI_NOT_GREEN',708));
 assert.ok(has(r,'CRITICAL_MAIN_CI_NOT_GREEN',726));
 assert.equal(r.critical_ci.find(x=>x.pr===829)?.conclusion,'success');
 assert.equal(r.full_source_acceptance,false);
 assert.equal(r.physical_broker_cas_proven,false);
});

test('QA24 independent owner overlaps: executors, CI workflow and hostile test',()=>{
 const r=reviewLive248Evidence(fresh()),c=r.critical_file_collisions;
 assert.equal(c.length,4);
 const match=(a:number,b:number,file:string)=>
  c.some(x=>[x.a,x.b].includes(a)&&[x.a,x.b].includes(b)&&x.files.includes(file));
 assert.ok(match(811,826,'src/agent/executors.ts'));
 assert.ok(match(801,802,'.github/workflows/ci.yml'));
 assert.ok(match(837,801,'.github/workflows/ci.yml'));
 assert.ok(match(847,849,'test/connection-826-direct-graph-unknown-deny.RED.test.ts'));
});

test('QA24 stale #609/#622 #794 #806 #814 #821 #845 never erased by green child',()=>{
 const r=reviewLive248Evidence(fresh());
 for(const pr of [609,622,794,806,814,821,845])
  assert.ok(has(r,'STALE_STACKED_PARENT_SHA',pr),String(pr));
});

test('QA24 duplicate PR/head and changed HEAD fail closed',()=>{
 const x=fresh();
 x.census.refs.push(structuredClone(x.census.refs[0]!));
 rec(x,811).head='f'.repeat(40);
 const r=reviewLive248Evidence(x);
 assert.ok(has(r,'PR_DUPLICATE_OR_BAD_REF'));
 assert.ok(has(r,'CRITICAL_HEAD_BASE_STALE_OR_DUPLICATED',811));
 assert.equal(r.current_safe_merge_queue.length,0);
});

test('QA24 mid-capture different refs or page gap blocks census',()=>{
 const x=fresh();x.census.refs_equal=false;x.census.second_counts=[100,100,47,0];
 const r=reviewLive248Evidence(x);
 assert.equal(r.authoritative_refs_two_pass,false);
 assert.ok(has(r,'OPEN_REST_TWO_PASS_INCOMPLETE'));
 assert.deepEqual(r.current_safe_merge_queue,[]);
});

test('QA24 forged exact CI on old SHA, invalid merge base, missing file scope blocked',()=>{
 const x=fresh();
 rec(x,826).ci.queried_head_sha='f'.repeat(40);
 rec(x,708).compare.merge_base=rec(x,708).base;
 rec(x,829).files=[];
 const r=reviewLive248Evidence(x);
 assert.ok(has(r,'CRITICAL_MAIN_CI_UNKNOWN_OR_STALE',826));
 assert.ok(has(r,'CRITICAL_MERGE_BASE_NOT_PROVEN',708));
 assert.ok(has(r,'CRITICAL_OWNER_FILE_SCOPE_MISSING',829));
 assert.equal(r.production_merge_authorized,false);
});
