import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const rd=(name:string)=>JSON.parse(readFileSync(path.resolve('docs/qa',name),'utf8').replace(/^\uFEFF/,'')) as any;
test('#617 source evidence and exact PR #618 CI must never be interpreted as native elevation',()=>{
 const e=rd('QA_20261021_HYPERV_617_ACCEPTANCE.json');
 assert.equal(e.reviewedMainSha,'4c5c810134c020cd04a5ef2be5c1138ea1954ad0');
 assert.equal(e.issue,617);
 assert.equal(e.pr618.state,'OPEN_DRAFT');
 assert.equal(e.pr618.authorReportedIsolated,'8/8 PASS');
 assert.equal(e.physicalVmStart,false);
 assert.equal(e.physicalUacInteraction,false);
 assert.equal(e.reportedIncident.runAs,'MUTATION_STATE_UNKNOWN');
 assert.equal(e.reportedIncident.actualVmState,'UNKNOWN');
 assert.equal(e.readOnlyEvidence.integrity,'MEDIUM_S-1-16-8192');
 assert.equal(e.readOnlyEvidence.administrators,'DENY_ONLY');
 assert.equal(e.readOnlyEvidence.brokerUnauthenticatedHttp,401);
 assert.equal(e.readOnlyEvidence.brokerAttested,false);
 assert.equal(e.readOnlyEvidence.vmStateVerified,false);
 assert.equal(e.mainSource.privilegeRequirementHypervStart,'standard');
 assert.equal(e.mainSource.brokerCapabilityHypervStart,false);
});
test('#617 nine independent acceptance cases include policy/token, local UAC, signed Broker, GUID, Running, lost ACK, 401 and no replay',()=>{
 const e=rd('QA_20261021_HYPERV_617_ACCEPTANCE.json');
 const cases=e.cases as Array<any>;
 assert.equal(cases.length,9);
 const ids=new Set(cases.map(x=>x.id));
 for(const id of ['617-TOKEN_VS_POLICY','617-LOCAL_UAC','617-BROKER_SIGNED_ACL_VERSION','617-EXACT_VM_GUID','617-READBACK_RUNNING','617-LOST_ACK_NO_REPLAY','617-UNAUTH_401','617-ADMIN_BRIDGE_INTENT','617-SIGNED_VM_CANARY']){
  assert.ok(ids.has(id),id);
 }
 for(const x of cases){
  assert.ok(x.requirements.length>0);
  assert.ok(x.expected.length>40);
  assert.ok(x.observed.length>30);
  assert.ok(['PASS','FAIL','BLOCKED'].includes(x.sourceStatus));
  assert.equal(x.staging,'BLOCKED');
  assert.equal(x.production,'BLOCKED');
  assert.equal(x.originalIncident,'BLOCKED');
 }
});
test('#617 P0 Hyper-V source contract blocks release regardless of green source-only #618',()=>{
 const m=rd('cross-project-final-acceptance.json');
 const l=rd('PR_SOURCE_AND_RELEASE_GATES.json');
 const f=rd('QA_BLOCKING_FINDINGS_CURRENT_MAIN.json');
 assert.equal(m.baselineSha,'754cc4364822be5fda528f54042fb22a84f19924');
 assert.equal(m.inspectedMainCi.runId,39622251466);
 assert.equal(m.requirements.length,22);
 assert.equal(l.entries.length,111);
 const pr618=l.entries.find((x:any)=>x.pr===618);
 assert.ok(pr618);
 assert.equal(pr618.prState,'OPEN_DRAFT');
 assert.equal(pr618.production,'BLOCKED');
 assert.equal(f.findingCount,39);
 assert.ok(f.findings.some((x:any)=>x.id==='QA16-617-HYPERV-ADMINBRIDGE'));
 for(const k of ['R01','R03','R04','R07','R09','R19','R20','R21','R22']){
  const r=m.requirements.find((x:any)=>x.id===k);
  assert.notEqual(r.levels.source.status,'PASS',k);
 }
 assert.ok(m.requirements.every((r:any)=>['staging','production','incident'].every(k=>r.levels[k].status==='BLOCKED')));
});
