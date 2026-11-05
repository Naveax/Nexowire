import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SemanticEffectJournal,SemanticEffectJournalError,
  semanticEffectFingerprint,semanticEffectGraphId,
} from '../../src/agent/runbook-effect-journal.js';
import {RunbookStore} from '../../src/agent/runbook-store.js';
import {executeDurableRunbook} from '../../src/agent/runbooks.js';

async function sandbox(t:import('node:test').TestContext){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nw-clean10-r3-'));
  t.after(async()=>fs.rm(root,{recursive:true,force:true}));
  return path.join(root,'runbooks.json');
}
const fingerprint=semanticEffectFingerprint(
  {jobs:[{id:'once',kind:'TEST_NO_OS_EFFECT',payload:{b:2,a:1}}]},'headless');
const input=(runbookId:string)=>({
  runbookId,stepId:'effect',fingerprint,
  graphId:semanticEffectGraphId(fingerprint),
});
function isDenied(error:unknown){
  return error instanceof SemanticEffectJournalError&&
    error.code.startsWith('RUNBOOK_EFFECT_');
}

test('CLEAN-10 R3: 32 concurrent O_EXCL reservations across separate journal instances admit one effect',async t=>{
  const stateFile=await sandbox(t);
  const contenders=Array.from({length:32},(_,i)=>new SemanticEffectJournal({
    stateFile,ownerId:'owner-A',deviceId:'device-A',
  }).reserve(input('runbook-'+i)));
  const results=await Promise.allSettled(contenders);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.ok(results.filter(x=>x.status==='rejected').every(x=>isDenied(x.reason)),
    'concurrent losers must fail closed, not dispatch');
  const rebooted=new SemanticEffectJournal({stateFile,ownerId:'owner-A',deviceId:'device-A'});
  await assert.rejects(rebooted.reserve(input('after-reboot')),isDenied);
});

test('CLEAN-10 R3: canonical graph input ignores JSON order, runbook ID and transport retry aliases',()=>{
  const a=semanticEffectFingerprint({jobs:[{id:'x',payload:{a:1,b:2}}],retry_unknown:false},'headless');
  const b=semanticEffectFingerprint({retry_unknown:true,jobs:[{payload:{b:2,a:1},id:'x'}]},'headless');
  assert.equal(a,b);
  assert.equal(semanticEffectGraphId(a),semanticEffectGraphId(b));
});

test('CLEAN-10 R3: owner/device mismatch never gains admission to an existing shared journal',async t=>{
  const stateFile=await sandbox(t);
  await new SemanticEffectJournal({stateFile,ownerId:'owner-A',deviceId:'device-A'})
    .reserve(input('first'));
  for(const [ownerId,deviceId] of [['owner-B','device-A'],['owner-A','device-B']] as const){
    await assert.rejects(
      new SemanticEffectJournal({stateFile,ownerId,deviceId}).reserve(input('foreign')),
      (e:unknown)=>e instanceof SemanticEffectJournalError&&
        e.code==='RUNBOOK_EFFECT_OWNER_DEVICE_MISMATCH');
  }
});

test('CLEAN-10 R3: corrupt reservation and missing owner metadata fail closed',async t=>{
  const stateFile=await sandbox(t);
  const journal=new SemanticEffectJournal({stateFile,ownerId:'owner-A',deviceId:'device-A'});
  await journal.reserve(input('first'));
  const root=stateFile+'.semantic-effects';
  await fs.writeFile(path.join(root,'effect-'+fingerprint+'.json'),'{"corrupt":true}\n');
  await assert.rejects(journal.reserve(input('cloned')),e=>e instanceof SemanticEffectJournalError&&
    e.code==='RUNBOOK_EFFECT_JOURNAL_CORRUPT');
  await fs.writeFile(path.join(root,'owner.json'),'{bad-json');
  await assert.rejects(journal.reserve(input('other')),isDenied);
});

test('CLEAN-10 R3: fresh identical user intent requires independent verifier; nonce alone never authorizes',async t=>{
  const stateFile=await sandbox(t);
  const journal=new SemanticEffectJournal({stateFile,ownerId:'owner-A',deviceId:'device-A'});
  await journal.reserve(input('original'));
  const intent={id:'01234567-89ab-4def-8123-123456789abc',
    ownerId:'owner-A',deviceId:'device-A',authorizationReceipt:'verified-synthetic-receipt-id-001'};
  const request={...input('new-verified-intent'),newIntent:intent};
  await assert.rejects(journal.reserve(request),isDenied);
  await assert.rejects(journal.reserve(request,async()=>false),isDenied);
  await assert.rejects(journal.reserve({...request,newIntent:{...intent,deviceId:'foreign-device'}},
    async()=>true),e=>e instanceof SemanticEffectJournalError&&
      e.code==='RUNBOOK_EFFECT_OWNER_DEVICE_MISMATCH');
  let reviews=0;
  await journal.reserve(request,async ({intent:submitted,fingerprint:fp,deviceId})=>{
    reviews++;
    return submitted.id===intent.id&&fp===fingerprint&&deviceId==='device-A';
  });
  assert.equal(reviews,1);
  await assert.rejects(journal.reserve(request,async()=>true),e=>
    e instanceof SemanticEffectJournalError&&e.code==='RUNBOOK_EFFECT_ALREADY_RESERVED');
});

test('CLEAN-10 R3: journal filesystem unavailable rejects before dispatch',async t=>{
  const stateFile=await sandbox(t);
  await fs.writeFile(stateFile+'.semantic-effects','not a directory');
  const store=new RunbookStore({stateFile});
  await store.initialize();
  let calls=0;
  const result=await executeDurableRunbook({
    runbook_id:'unavailable',steps:[{id:'effect',kind:'task_graph',
      task_graph:{jobs:[{id:'x',kind:'TEST_NO_OS_EFFECT'}]}}],
  },store,{runTaskGraph:async()=>{calls++;return {data:{ok:true}};},
    runAssertions:async()=>({data:{ok:true}})}) as {
    data:{ok:boolean,steps:Array<{status:string,errorCode:string}>}};
  assert.equal(calls,0);
  assert.equal(result.data.ok,false);
  assert.equal(result.data.steps[0]?.status,'unknown');
  assert.match(result.data.steps[0]?.errorCode,/^RUNBOOK_EFFECT_/);
});

test('CLEAN-10 R3: cloned step identity after a lost ACK cannot redispatch on restart',async t=>{
  const stateFile=await sandbox(t);
  let calls=0;
  const callbacks={
    runTaskGraph:async()=>{
      calls++;
      throw Object.assign(new Error('ACK lost'),{code:'MUTATION_STATE_UNKNOWN'});
    },
    runAssertions:async()=>({data:{ok:true}}),
  };
  const s1=new RunbookStore({stateFile});await s1.initialize();
  const steps=[{id:'original-step',kind:'task_graph',task_graph:{
    jobs:[{id:'same-effect',kind:'TEST_NO_OS_EFFECT'}]}}];
  const first=await executeDurableRunbook({runbook_id:'original',steps},s1,callbacks) as {
    data:{steps:Array<{status:string}>}};
  assert.equal(first.data.steps[0]?.status,'unknown');
  const s2=new RunbookStore({stateFile});await s2.initialize();
  const cloned=await executeDurableRunbook({
    runbook_id:'cloned',steps:[{...steps[0],id:'renamed-step'}],
  },s2,callbacks) as {data:{steps:Array<{status:string}>}};
  assert.equal(cloned.data.steps[0]?.status,'unknown');
  assert.equal(calls,1);
});

for(const envelopeOk of [false,true]) {
  test('CLEAN-10 R3: nested task graph UNKNOWN survives outer ok='+envelopeOk+' and restart clone',async t=>{
    const stateFile=await sandbox(t);
    const original=new RunbookStore({stateFile});
    await original.initialize();
    let calls=0;
    const callbacks={
      runTaskGraph:async()=>{
        calls++;
        return {data:{ok:envelopeOk,summary:{
          total:1,unknown:1,failed:0,succeeded:0,
        },results:[{id:'lost-ack',status:'unknown'}]}};
      },
      runAssertions:async()=>({data:{ok:true}}),
    };
    const effect={jobs:[{id:'lost-ack',kind:'TEST_NO_OS_EFFECT'}]};
    const first=await executeDurableRunbook({
      runbook_id:'nested-original',
      steps:[{id:'task',kind:'task_graph',task_graph:effect}],
    },original,callbacks) as {data:{ok:boolean,steps:Array<{status:string,errorCode:string}>}};
    assert.equal(first.data.ok,false);
    assert.equal(first.data.steps[0]?.status,'unknown');
    assert.equal(first.data.steps[0]?.errorCode,'MUTATION_STATE_UNKNOWN');
    assert.equal(original.get('nested-original').steps[0]?.status,'unknown');

    const restarted=new RunbookStore({stateFile});
    await restarted.initialize();
    const cloned=await executeDurableRunbook({
      runbook_id:'nested-clone',
      steps:[{id:'renamed',kind:'task_graph',task_graph:effect}],
    },restarted,callbacks) as {data:{ok:boolean,steps:Array<{status:string}>}};
    assert.equal(cloned.data.ok,false);
    assert.equal(cloned.data.steps[0]?.status,'unknown');
    assert.equal(calls,1,'a nested UNKNOWN must prevent a cloned mutation callback');
  });
}
