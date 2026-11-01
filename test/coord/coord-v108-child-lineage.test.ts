import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('../../scripts/coord-v108-child-lineage.mjs',import.meta.url));
const sha=(n:number)=>n.toString(16).padStart(40,'0');
const pairs=[[990,1004],[980,1005],[985,1007]] as const;
function fixture(){
  const prs=[];
  for(const [parent,child] of pairs){
    const ref='test/parent-'+parent;
    prs.push({number:parent,state:'open',draft:true,head:{ref,sha:sha(parent)},base:{ref:'main',sha:sha(1)}});
    prs.push({number:child,state:'open',draft:true,head:{ref:'test/child-'+child,sha:sha(child)},base:{ref,sha:sha(parent)}});
  }
  return {prs,rechecked:{prs:structuredClone(prs)}};
}
function check(data:ReturnType<typeof fixture>){
  const dir=mkdtempSync(path.join(os.tmpdir(),'v108-lineage-test-'));
  try{
    const file=path.join(dir,'data.json');
    writeFileSync(file,JSON.stringify(data));
    const result=spawnSync(process.execPath,[script,'--fixture',file],{encoding:'utf8',timeout:15000});
    assert.ok(result.stdout.length>0,result.stderr);
    return {code:result.status,output:JSON.parse(result.stdout)};
  }finally{rmSync(dir,{recursive:true,force:true});}
}

test('aligned child PRs still never authorize merge, deploy or CORE',()=>{
  const {code,output}=check(fixture());
  assert.equal(code,0);
  assert.equal(output.status,'LINEAGE_ALIGNED_REVIEW_REQUIRED');
  assert.equal(output.origin,'UNTRUSTED_FIXTURE');
  assert.equal(output.mergeAuthorized,false);
  assert.equal(output.deployAuthorized,false);
  assert.equal(output.productionCore,'NO_GO');
});

test('a previously green child cannot inherit a newly moved parent head',()=>{
  const data=fixture();
  data.prs.find(x=>x.number===990)!.head.sha=sha(9990);
  const {code,output}=check(data);
  assert.equal(code,2);
  assert.ok(output.findings.includes('PR_1004:STALE_PARENT_HEAD'));
});

test('ref mismatch is an independent blocker even if SHA is equal',()=>{
  const data=fixture();
  data.prs.find(x=>x.number===1005)!.base.ref='unexpected';
  const {code,output}=check(data);
  assert.equal(code,2);
  assert.ok(output.findings.includes('PR_1005:PARENT_REF_MISMATCH'));
});

test('closed or non-draft child is not accepted as source-ready',()=>{
  const data=fixture();
  data.prs.find(x=>x.number===1007)!.draft=false;
  const {code,output}=check(data);
  assert.equal(code,2);
  assert.ok(output.findings.includes('PR_1007:CHILD_STATE_OR_SHA_INVALID'));
});

test('rechecked moving head cannot count as a consistent proof',()=>{
  const data=fixture();
  data.rechecked.prs.find(x=>x.number===985)!.head.sha=sha(99985);
  const {code,output}=check(data);
  assert.equal(code,2);
  assert.ok(output.findings.includes('PR_1007:PR_MOVED_DURING_AUDIT'));
  assert.equal(output.origin,'UNTRUSTED_FIXTURE');
  assert.equal(output.mergeAuthorized,false);
});

test('duplicate PR identity is fail closed',()=>{
  const data=fixture();
  data.prs.push({...data.prs[0]!});
  const {code,output}=check(data);
  assert.equal(code,2);
  assert.ok(output.findings.includes('DUPLICATE_PR_990'));
});
