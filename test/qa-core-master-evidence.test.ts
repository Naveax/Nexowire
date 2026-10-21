import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const get=(name:string)=>JSON.parse(readFileSync(path.resolve('docs/qa',name),'utf8').replace(/^\uFEFF/,'')) as any;
test('CORE MASTER full admin is NOT a SAFE alias: persistent CORE, <=15min ROOT, standard FULL, once approved signed Broker',()=>{
 const s=get('QA_20261021_CORE_MASTER_ACCEPTANCE.json');
 assert.equal(s.mainSha,'4c5c810134c020cd04a5ef2be5c1138ea1954ad0');
 assert.match(s.coreGoal,/persistent revocable/i);
 assert.match(s.coreGoal,/900s/);
 assert.match(s.coreGoal,/one genuine local owner UAC/i);
 assert.match(s.coreGoal,/broad high-integrity shell/i);
 assert.match(s.coreGoal,/FULL broad standard/i);
 assert.equal(s.independentTests.pass,5);
 assert.equal(s.independentTests.fail,3);
 assert.equal(s.independentTests.skip,0);
 assert.equal(s.production,'BLOCKED');
});
test('CORE master exact-head PR ledger distinguishes red latest, green old-base and source only success',()=>{
 const s=get('QA_20261021_CORE_MASTER_ACCEPTANCE.json');
 const entries=get('PR_SOURCE_AND_RELEASE_GATES.json').entries as any[];
 const row=(n:number)=>entries.find(v=>v.pr===n);
 assert.equal(entries.length,85);
 for(const n of [618,620,576])assert.equal(row(n).ci.status,'FAIL','RED #'+n);
 for(const n of [619,608,614,616,609,610,612,613,615,551])assert.equal(row(n).ci.status,'PASS','GREEN #'+n);
 assert.equal(row(618).ci.runId,39605003581);
 assert.equal(row(619).ci.runId,39604390404);
 assert.equal(row(620).ci.runId,39604898508);
 assert.equal(row(576).ci.runId,39598258315);
 assert.equal(row(614).ci.runId,39598693419);
 assert.equal(row(616).ci.runId,39598755514);
 assert.equal(row(551).ci.runId,39606595530);
 assert.equal(row(608).ci.runId,39503650650);
 assert.ok(s.pulls.every((v:any)=>v.production==='BLOCKED'&&v.staging==='BLOCKED'));
});
test('CORE MASTER 14 P0 acceptance gates cover revocation, forged UAC, elevated wide shell, signed launcher and HyperV readback',()=>{
 const s=get('QA_20261021_CORE_MASTER_ACCEPTANCE.json');
 assert.equal(s.cases.length,14);
 const ids=new Set(s.cases.map((r:any)=>r.id));
 for(const id of ['ROOT_15MIN','CORE_PERSISTENT','FULL_STANDARD','ONE_TIME_UAC_BOOTSTRAP','SIGNED_ACL_IDENTITY','OWNER_REVOKE_REPAIR','LOST_ACK_NO_REPLAY','SIGNED_BROKER_WIDE_SHELL','TYPED_HYPERV_VM_ID','VM_RUNNING_READBACK','WINDOWS_JOB_PIPE','SIGNED_ROLLBACK','ARTIFACT_QUOTA','OWNER_WSS_SCOPE'])
  assert.ok(ids.has(id),id);
 for(const r of s.cases){assert.ok(r.expected.length>35);assert.ok(r.requirements.length>0);assert.equal(r.staging,'BLOCKED');assert.equal(r.production,'BLOCKED');assert.equal(r.originalIncident,'BLOCKED');}
});
test('R01-R22 main matrix source and production cannot be upgraded from PR CI',()=>{
 const a=get('cross-project-final-acceptance.json');
 const f=get('QA_BLOCKING_FINDINGS_CURRENT_MAIN.json');
 assert.equal(a.requirements.length,22);
 assert.equal(f.findingCount,33);
 for(const id of ['QA16-P0-CORE-REAL-ELEVATION','QA16-P0-TRUSTED-BROKER-JOB-CI','QA16-P0-WITNESS-OWNER-EPOCH'])assert.ok(f.findings.some((r:any)=>r.id===id),id);
 for(const k of ['R02','R04','R07','R15','R20','R22']){
  assert.equal(a.requirements.find((x:any)=>x.id===k).levels.source.status,'FAIL');
 }
 assert.ok(a.requirements.every((r:any)=>['staging','production','incident'].every(k=>r.levels[k].status==='BLOCKED')));
});
