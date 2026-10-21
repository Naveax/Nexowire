import test from 'node:test';
import assert from 'node:assert/strict';
import {readPinned77,reviewFrozenDag,type FrozenSnapshot} from '../scripts/qa24-safe-merge-review.js';

const copy=()=>structuredClone(readPinned77());
const risk=(s:FrozenSnapshot,id:number)=>reviewFrozenDag(s).risks.find(x=>x.pr===id)?.codes??[];
const node=(s:FrozenSnapshot,id:number)=>{const n=s.nodes.find(x=>x.pr===id);assert.ok(n,`Missing ${id}`);return n;};

test('QA24 exact GitHub 77 snapshot has 49 edges and refuses automatic merge',()=>{
  const s=copy(),r=reviewFrozenDag(s);
  assert.equal(s.nodes.length,77);
  assert.equal(new Set(s.nodes.map(n=>n.pr)).size,77);
  assert.equal(s.nodes.filter(n=>n.parent_pr!==null).length,49);
  assert.equal(s.nodes.filter(n=>n.ci.conclusion==='success').length,44);
  assert.equal(s.nodes.filter(n=>n.ci.conclusion==='failure').length,33);
  assert.equal(r.gate,'NO_GO');
  assert.equal(r.automatic_merge_allowed,false);
  assert.equal(r.global_files_complete,false);
});

test('QA24 core #670/#669/#672/#676 green cannot bypass inherited red or physical trust',()=>{
  const s=copy();
  assert.ok(risk(s,670).includes('ANCESTOR_CI_NOT_GREEN'));
  assert.ok(risk(s,669).includes('ANCESTOR_CI_NOT_GREEN'));
  assert.ok(risk(s,672).includes('STACKED_REQUIRES_INTEGRATOR_REVIEW'));
  assert.ok(risk(s,676).includes('ANCESTOR_CI_NOT_GREEN'));
});

test('QA24 old #609/#622 parent bases remain stale',()=>{
  const s=copy();
  assert.ok(risk(s,609).includes('STALE_PARENT'));
  assert.ok(risk(s,622).includes('STALE_PARENT'));
});

test('QA24 SHA moved #572 #575 #642 #664 never inherits old merge-base',()=>{
  const s=copy();
  for(const id of [572,575,642,664])
    assert.ok(risk(s,id).includes('MERGE_BASE_NOT_CURRENTLY_PROVEN'),String(id));
  assert.equal(node(s,572).head_sha,'ca67b8adc717256906f8396d8057104df66be946');
});

test('QA24 exact SHA mismatch denies former green CI',()=>{
  const s=copy();node(s,648).head_sha='f'.repeat(40);
  assert.ok(risk(s,648).includes('CI_HEAD_UNVERIFIED'));
  assert.ok(!reviewFrozenDag(s).review_candidates.some(x=>x.pr===648));
});

test('QA24 completed failure and canceled CI are not source-merge candidates',()=>{
  const s=copy();
  assert.ok(risk(s,664).includes('CI_NOT_GREEN'));
  assert.ok(risk(s,674).includes('CI_NOT_GREEN'));
  node(s,648).ci.conclusion='cancelled';
  assert.ok(risk(s,648).includes('CI_NOT_GREEN'));
});

test('QA24 ownership collision on independent branches blocks source-only review',()=>{
  const s=copy();
  const src648=s.file_claims.find(x=>x.pr===648)!;
  const src657=s.file_claims.find(x=>x.pr===657)!;
  src657.files.push(src648.files[0]!);
  assert.ok(risk(s,657).includes('OWNER_COLLISION_REVIEW'));
  assert.ok(!reviewFrozenDag(s).review_candidates.some(x=>x.pr===657));
});

test('QA24 only provisional docs/test review candidates, never P0 merge approval',()=>{
  const s=copy();const r=reviewFrozenDag(s);
  for(const pr of [648,657]){
    const c=r.review_candidates.find(x=>x.pr===pr);
    assert.ok(c,String(pr));
    assert.equal(c.review_status,'CONDITIONAL_SOURCE_REVIEW_ONLY');
    assert.ok(c.requirements.some(x=>x.includes('complete changed paths')));
  }
  for(const pr of [675,671,670,676,669,664,667])
    assert.equal(r.review_candidates.some(x=>x.pr===pr),false,String(pr));
});

test('QA24 incomplete global changed-file coverage remains a finding',()=>{
  const s=copy();
  assert.ok(risk(s,648).includes('GLOBAL_FILE_COVERAGE_INCOMPLETE'));
  s.file_claims=s.file_claims.filter(x=>x.pr!==648);
  assert.ok(risk(s,648).includes('FILES_INCOMPLETE'));
  assert.ok(!reviewFrozenDag(s).review_candidates.some(x=>x.pr===648));
});

test('QA24 planted unknown parent and stale main are review blockers',()=>{
  const s=copy();node(s,648).base_sha='a'.repeat(40);
  assert.ok(risk(s,648).includes('MAIN_NOT_CURRENT'));
  node(s,657).parent_pr=999999;
  assert.ok(risk(s,657).includes('UNKNOWN_PARENT'));
});

test('QA24 broad CORE feature cannot become source-only by passing CI',()=>{
  const s=copy();const n=node(s,675);
  assert.equal(n.ci.conclusion,'success');
  assert.ok(risk(s,675).includes('NOT_SOURCE_ONLY'));
});
