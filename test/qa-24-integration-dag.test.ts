import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditIntegrationDag,loadPinnedSnapshot,
  type DagSnapshot,
} from '../scripts/qa24-integration-dag.js';

const fresh=():DagSnapshot=>structuredClone(loadPinnedSnapshot());
const codes=(s:DagSnapshot)=>auditIntegrationDag(s).findings.map(f=>f.code);
const findings=(s:DagSnapshot,code:string)=>auditIntegrationDag(s).findings.filter(f=>f.code===code);

test('QA24 38 open PRs are pinned to 40-char HEAD SHA and per-SHA CI run IDs',()=>{
  const s=fresh();
  assert.equal(s.node_count,38);
  assert.equal(new Set(s.nodes.map(n=>n.pr)).size,38);
  assert.equal(s.nodes.filter(n=>n.parent_pr!==null).length,19);
  assert.equal(codes(s).includes('INVALID_SHA'),false);
  assert.equal(codes(s).includes('MISSING_EXACT_HEAD_CI'),false);
  assert.equal(auditIntegrationDag(s).gate,'NO_GO');
});

test('QA24 known six stacked bases are independently verifiable',()=>{
  const s=fresh(),by=new Map(s.nodes.map(n=>[n.pr,n]));
  for(const [child,parent] of ([[633,620],[621,574],[632,551],[631,614],[629,622],[634,616]] as const)) {
    assert.equal(by.get(child)?.parent_pr,parent);
    assert.equal(by.get(child)?.base_sha,by.get(parent)?.head_sha);
  }
});

test('QA24 stale base HEAD cannot inherit green CI or be treated as current',()=>{
  const s=fresh();
  const stale=findings(s,'STALE_PARENT_SHA').map(f=>f.prs[0]);
  assert.ok(stale.includes(622));
  assert.ok(stale.includes(609));
  const child=s.nodes.find(n=>n.pr===633)!;
  child.base_sha='f'.repeat(40);
  assert.ok(findings(s,'STALE_PARENT_SHA').some(f=>f.prs[0]===633));
});

test('QA24 bad merge-base evidence is fail-closed even with green child workflow',()=>{
  const s=fresh();
  const c=s.comparisons.find(x=>x.pr===633)!;
  c.merge_base_sha='0'.repeat(40);
  c.status='diverged';
  assert.ok(findings(s,'STALE_MERGE_BASE').some(f=>f.prs[0]===633));
});

test('QA24 unrelated Windows Job owners collide; parent-child overlap is not a false conflict',()=>{
  const s=fresh(), list=findings(s,'OWNER_COLLISION');
  assert.ok(list.some(f=>f.prs.includes(629)&&f.prs.includes(633)));
  assert.ok(list.some(f=>f.prs.includes(576)&&f.prs.includes(629)));
  assert.equal(list.some(f=>f.prs.includes(620)&&f.prs.includes(633)),false);
  assert.equal(list.some(f=>f.prs.includes(574)&&f.prs.includes(621)),false);
  assert.equal(list.some(f=>f.prs.includes(616)&&f.prs.includes(634)),false);
});

test('QA24 malicious independent owner collision fixture is rejected',()=>{
  const s=fresh();
  s.file_claims.push({pr:551,owner:'synthetic hostile fixture',
    files:['src/agent/process-manager.ts']});
  assert.ok(findings(s,'OWNER_COLLISION').some(f=>f.prs.includes(551)&&f.prs.includes(633)));
});

test('QA24 missing parent and dependency cycle are detected without infinite traversal',()=>{
  const missing=fresh();
  missing.nodes.find(n=>n.pr===633)!.parent_pr=999999;
  assert.ok(codes(missing).includes('MISSING_PARENT'));
  const cyclic=fresh();
  cyclic.nodes.find(n=>n.pr===620)!.parent_pr=633;
  assert.ok(codes(cyclic).includes('DEPENDENCY_CYCLE'));
});

test('QA24 duplicate PR, invalid sha and spoofed CI state are denied',()=>{
  const s=fresh();
  s.nodes.push(structuredClone(s.nodes[0]!));
  s.nodes[0]!.head_sha='short';
  s.nodes[0]!.ci.status='completed';
  s.nodes[0]!.ci.conclusion=null;
  for(const c of ['DUPLICATE_OR_INVALID_PR','NODE_COUNT_MISMATCH','INVALID_SHA','INVALID_CI_CONCLUSION']) {
    assert.ok(codes(s).includes(c),c);
  }
});

test('QA24 green child never erases parent failure or pending jobs',()=>{
  const s=fresh();
  assert.ok(findings(s,'PARENT_CI_NOT_GREEN').some(f=>f.prs[0]===633&&f.prs[1]===620));
  assert.ok(findings(s,'PARENT_CI_NOT_GREEN').some(f=>f.prs[0]===621&&f.prs[1]===574));
  for(const pr of [635,636,637]) {
    assert.ok(findings(s,'UNVERIFIED_CI').some(f=>f.prs.includes(pr)));
  }
});

test('QA24 source-only audit does not establish Windows high token or production grant',()=>{
  const s=fresh();
  s.nodes.forEach(n=>{n.ci.status='completed';n.ci.conclusion='success';});
  assert.equal(auditIntegrationDag(s).gate,'NO_GO');
});
