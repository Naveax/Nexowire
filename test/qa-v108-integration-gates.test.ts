import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const cli=fileURLToPath(new URL('../scripts/qa-v108-integration-gates.mjs',import.meta.url));
const required=[
  'test (22)','test (24)','browser-live','linux-native-live','wsl2-live',
  'security-operational-live','macos-agent-lifecycle-live',
];
const specs=[
  [980,'integration/core-after-v108-20261030','main',null],
  [981,'core/bounded-native-verifier-host-20261030',null,980],
  [982,'core/native-verifier-mtls-client-20261031',null,981],
  [983,'local/persistent-enrollment-design-20261031',null,982],
  [984,'local/persistent-enrollment-v2-20261031',null,983],
  [986,'ai/01-wal-v108','main',null],
  [993,'ai/02-enrollment-hardening-20261031',null,984],
  [988,'ai/03-native-verifier-20261031',null,982],
  [987,'ai/04-broker-admission-20261031',null,980],
  [992,'ai/05-cas-executor',null,980],
  [985,'ai/06-console-claim',null,980],
  [990,'ai/07-isolation-worker-20261031','docs/07-task-os-sandbox-provider-contract-20261024',null],
  [989,'ai/08-independent-qa-20261031',null,984],
] as const;

function makeFixture() {
  const mainSha='f'.repeat(40);
  const sha=(n:number)=>n.toString(16).padStart(40,'0');
  const heads=new Map(specs.map(([n,ref])=>[n,{ref,sha:sha(n)}]));
  const prs=specs.map(([number,ref,base,parent])=>({
    number,state:'open',draft:true,
    head:{ref,sha:sha(number)},
    base:parent?heads.get(parent)!:{ref:base,sha:base==='main'?mainSha:'e'.repeat(40)},
  }));
  const runs:Record<string,Array<Record<string,unknown>>>={};
  for (const [number] of specs) {
    const id=400000+number;
    const jobNames=[...required,...(number===993?['local-enrollment-native']:[])];
    runs[String(number)]=[{
      id,name:'CI',path:'.github/workflows/ci.yml',
      head_sha:sha(number),status:'completed',conclusion:'success',
      created_at:'2026-10-31T11:00:00Z',
      jobs:jobNames.map(name=>({name,status:'completed',conclusion:'success',run_id:id})),
    }];
  }
  return {mainSha,prs,runs};
}

type Fixture=ReturnType<typeof makeFixture>;
function check(snapshot:Fixture) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'nw-v108-coordinator-'));
  try {
    const filename=path.join(dir,'fixture.json');
    writeFileSync(filename,JSON.stringify(snapshot));
    return spawnSync(process.execPath,[cli,'--fixture',filename],{
      encoding:'utf8',timeout:15000,env:{...process.env,GITHUB_TOKEN:''},
    });
  } finally {rmSync(dir,{recursive:true,force:true});}
}

test('exact-head green CI is review-only; never physical CORE approval',()=>{
  const result=check(makeFixture());
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/SOURCE_CI_COMPLETE_REVIEW_REQUIRED/);
  assert.match(result.stdout,/CORE production: \*\*NO_GO\*\*/);
  assert.match(result.stdout,/UNTRUSTED_FIXTURE/);
});

test('upstream base moves without consumer rebase: block',()=>{
  const f=makeFixture();
  f.prs.find(p=>p.number===993)!.base.sha='a'.repeat(40);
  const result=check(f);
  assert.equal(result.status,2);
  assert.match(result.stdout,/BASE_HEAD_SHA_MISMATCH/);
});

test('green CI for an old SHA does not satisfy latest head',()=>{
  const f=makeFixture();
  f.runs['986']![0]!.head_sha='a'.repeat(40);
  const result=check(f);
  assert.equal(result.status,2);
  assert.match(result.stdout,/EXACT_HEAD_CI_MISSING/);
});

test('pending and duplicate active CI never count as PASS',()=>{
  const f=makeFixture();
  const run=f.runs['992']![0]!;
  run.status='in_progress';run.conclusion=null;
  f.runs['992']!.push({...run,id:999999});
  const result=check(f);
  assert.equal(result.status,2);
  assert.match(result.stdout,/DUPLICATE_ACTIVE_CI/);
  assert.match(result.stdout,/EXACT_HEAD_CI_PENDING/);
});

test('missing Windows native-enrollment job blocks even if other jobs pass',()=>{
  const f=makeFixture();
  f.runs['993']![0]!.jobs=(f.runs['993']![0]!.jobs as Array<{name:string}>).filter(
    j=>j.name!=='local-enrollment-native',
  );
  const result=check(f);
  assert.equal(result.status,2);
  assert.match(result.stdout,/CI_REQUIRED_JOB_MISSING_OR_DUPLICATED/);
});

test('source CI RED blocks with no merge or deploy action',()=>{
  const f=makeFixture();
  f.runs['988']![0]!.conclusion='failure';
  const result=check(f);
  assert.equal(result.status,2);
  assert.match(result.stdout,/EXACT_HEAD_CI_NOT_GREEN/);
  assert.match(result.stdout,/No merge, CI dispatch, deployment or live device operations performed/);
});

test('moving PR HEAD during long CI inspection must fail closed',()=>{
  const original=makeFixture();
  const snapshot={...original,rechecked:{
    mainSha:original.mainSha,
    prs:original.prs.map(p=>({
      ...p,head:{...p.head,sha:p.number===992?'a'.repeat(40):p.head.sha},
      base:{...p.base},
    })),
  }};
  const result=check(snapshot);
  assert.equal(result.status,2,result.stderr);
  assert.match(result.stdout,/PR_MOVED_DURING_AUDIT/);
});

test('moving main during live source audit must fail closed',()=>{
  const original=makeFixture();
  const snapshot={...original,rechecked:{
    mainSha:'a'.repeat(40),
    prs:original.prs.map(p=>({...p,head:{...p.head},base:{...p.base}})),
  }};
  const result=check(snapshot);
  assert.equal(result.status,2,result.stderr);
  assert.match(result.stdout,/MAIN_MOVED_DURING_AUDIT/);
});

test('an active exact-SHA run blocks even when another run is green',()=>{
  const f=makeFixture();
  const completed=f.runs['986']![0]!;
  f.runs['986']!.push({
    ...completed,id:888888,status:'in_progress',conclusion:null,
    created_at:'2026-10-31T10:59:00Z',
  });
  const result=check(f);
  assert.equal(result.status,2,result.stderr);
  assert.match(result.stdout,/EXACT_HEAD_CI_ACTIVE/);
});

test('two AI PRs changing the same source file block integration',()=>{
  const original=makeFixture();
  const changedFiles:Record<string,string[]>={
    '986':['src/agent/operation-journal-wal.ts'],
    '993':['native/windows-local-enrollment/EnrollmentClient.cs'],
    '988':['src/security/core-native-mtls-fetch.ts'],
    '987':['src/agent/privileged-broker-effect-admission.ts'],
    '992':['src/agent/postgres-bound-grant-cas.ts'],
    '985':['src/product/d1-core-console-authority.ts'],
    '990':['src/agent/task-os-sandbox-policy.ts'],
    '989':['test/ai08-wal-recycle.test.ts'],
  };
  changedFiles['989']!.push('src/agent/operation-journal-wal.ts');
  const result=check({...original,changedFiles});
  assert.equal(result.status,2,result.stderr);
  assert.match(result.stdout,/SOURCE_FILE_OWNERSHIP_COLLISION/);
  assert.match(result.stdout,/src\/agent\/operation-journal-wal\.ts/);
});

test('agent may update own handoff folder but not another agent handoff',()=>{
  const original=makeFixture();
  const changedFiles:Record<string,string[]>={
    '986':['docs/ai-handoff/AI-01/STATUS.md'],
    '993':['docs/ai-handoff/AI-02/STATUS.md'],
    '988':['docs/ai-handoff/AI-03/STATUS.md'],
    '987':['docs/ai-handoff/AI-04/STATUS.md'],
    '992':['docs/ai-handoff/AI-05/STATUS.md'],
    '985':['docs/ai-handoff/AI-06/STATUS.md'],
    '990':['docs/ai-handoff/AI-07/STATUS.md'],
    '989':['docs/ai-handoff/AI-08/STATUS.md'],
  };
  assert.equal(check({...original,changedFiles}).status,0);
  changedFiles['990']!.push('docs/ai-handoff/AI-05/FINAL.md');
  const violation=check({...original,changedFiles});
  assert.equal(violation.status,2);
  assert.match(violation.stdout,/CROSS_AGENT_HANDOFF_WRITE/);
});
