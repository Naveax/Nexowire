import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AgentOperationJournal} from '../src/agent/operation-journal.js';

async function fresh(t:import('node:test').TestContext,maxRecords?:number){
  const dir=await mkdtemp(path.join(os.tmpdir(),'nw-agent-journal-sqlite-'));
  const file=path.join(dir,'agent-operations.sqlite');
  const all:AgentOperationJournal[]=[];
  const open=()=>{const j=new AgentOperationJournal(file,
    maxRecords!==undefined?{maxRecords}:{});all.push(j);return j};
  t.after(async()=>{
    for(const journal of all){try{journal.close()}catch{}}
    await rm(dir,{recursive:true,force:true});
  });
  return {file,journal:open(),open};
}
const fp=(ch='a')=>ch.repeat(64);

test('reserve durably, finalize and block duplicate mutation across Agent restart',async t=>{
  const {journal,open}=await fresh(t);
  const id=randomUUID();
  const first=await journal.begin(id,fp(),'shell.exec');
  assert.equal(first.created,true);
  assert.equal(first.record.status,'in_progress');
  await journal.complete(id,'succeeded');
  journal.close();
  const restarted=open();
  assert.equal((await restarted.inspect(id))?.status,'succeeded');
  assert.equal((await restarted.begin(id,fp(),'shell.exec')).created,false);
  await assert.rejects(restarted.begin(id,fp('b'),'shell.exec'),
    {code:'AGENT_JOURNAL_REQUEST_MISMATCH'});
  await assert.rejects(restarted.begin(id,fp(),'files.delete'),
    {code:'AGENT_JOURNAL_REQUEST_MISMATCH'});
});
test('crash between reservation and completion yields persistent UNKNOWN',async t=>{
  const {journal,open}=await fresh(t);
  const id=randomUUID();
  await journal.begin(id,fp(),'wsl.exec');
  journal.close();
  const restarted=open();
  assert.equal((await restarted.inspect(id))?.status,'unknown');
  assert.equal((await restarted.begin(id,fp(),'wsl.exec')).created,false);
  await assert.rejects(restarted.complete(id,'succeeded'),
    {code:'AGENT_JOURNAL_TRANSITION_DENIED'});
});
test('failed outcome remains recorded rather than being re-executed',async t=>{
  const {journal,open}=await fresh(t);
  const id=randomUUID();
  await journal.begin(id,fp(),'files.delete');
  await journal.complete(id,'failed');
  journal.close();
  assert.equal((await open().begin(id,fp(),'files.delete')).record.status,'failed');
});
test('explicit bounded journal never evicts a completed request ID',async t=>{
  const {journal,open}=await fresh(t,1);
  const id=randomUUID();
  await journal.begin(id,fp(),'files.delete');
  await journal.complete(id,'succeeded');
  await assert.rejects(journal.begin(randomUUID(),fp(),'shell.exec'),
    {code:'AGENT_JOURNAL_FULL'});
  journal.close();
  assert.equal((await open().begin(id,fp(),'files.delete')).created,false);
});
test('interleaved requests retain every durable reservation',async t=>{
  const {journal,open}=await fresh(t);
  const ids=Array.from({length:25},()=>randomUUID());
  const results=await Promise.all(ids.map(id=>journal.begin(id,fp(),'shell.exec')));
  assert.equal(results.filter(x=>x.created).length,25);
  journal.close();
  const restarted=open();
  for(const id of ids)assert.equal((await restarted.inspect(id))?.status,'unknown');
});
test('database corruption blocks startup rather than clearing unknown operations',async t=>{
  const {file,journal}=await fresh(t);
  await writeFile(file,'{garbled json','utf8');
  await assert.rejects(journal.begin(randomUUID(),fp(),'shell.exec'));
  assert.equal((await readFile(file,'utf8')).startsWith('{garbled'),true);
});
test('stored record has only metadata and never command/token/body fields',async t=>{
  const {file,journal}=await fresh(t);
  const id=randomUUID();
  await journal.begin(id,fp(),'shell.exec');
  await journal.complete(id,'succeeded');
  assert.deepEqual(Object.keys((await journal.inspect(id))!).sort(),
    ['capability','createdAt','fingerprint','requestId','status','updatedAt']);
  const bytes=await readFile(file);
  assert.equal(bytes.includes(Buffer.from('SECRET_DO_NOT_STORE')),false);
});
test('unwritable journal path fails before dispatch',async t=>{
  const {file,journal}=await fresh(t);
  await writeFile(path.dirname(file)+'/occupied','not a directory');
  const j=new AgentOperationJournal(path.join(path.dirname(file),'occupied','journal.sqlite'));
  await assert.rejects(j.begin(randomUUID(),fp(),'shell.exec'));
  journal.close();
});
test('terminal journal states cannot transition backwards',async t=>{
  const {journal}=await fresh(t);
  const id=randomUUID();
  await journal.begin(id,fp(),'shell.exec');
  await journal.complete(id,'succeeded');
  await assert.rejects(journal.complete(id,'failed'),
    {code:'AGENT_JOURNAL_TRANSITION_DENIED'});
});
test('successful Agent transport can preserve a failed process exit',async t=>{
  const {journal,open}=await fresh(t);
  const id=randomUUID();
  await journal.begin(id,fp(),'shell.exec');
  await journal.complete(id,'succeeded',{
    processExitCode:17,taskSuccess:false,timedOut:false,
  });
  journal.close();
  const rec=await open().inspect(id);
  assert.equal(rec?.status,'succeeded');
  assert.equal(rec?.processExitCode,17);
  assert.equal(rec?.taskSuccess,false);
  assert.equal(rec?.timedOut,false);
});
test('timeout is distinct from shell exit success',async t=>{
  const {journal,open}=await fresh(t);
  const id=randomUUID();
  await journal.begin(id,fp(),'wsl.exec');
  await journal.complete(id,'succeeded',{
    processExitCode:null,taskSuccess:false,timedOut:true,
  });
  journal.close();
  const rec=await open().inspect(id);
  assert.equal(rec?.processExitCode,null);
  assert.equal(rec?.taskSuccess,false);
  assert.equal(rec?.timedOut,true);
});
test('journal can record hundreds of operations without rewriting one JSON array',async t=>{
  const {journal,open}=await fresh(t);
  const ids=Array.from({length:230},()=>randomUUID());
  for(const id of ids){
    await journal.begin(id,fp(),'shell.exec');
    await journal.complete(id,'succeeded');
  }
  journal.close();
  const other=open();
  assert.equal((await other.inspect(ids[0]!))?.status,'succeeded');
  assert.equal((await other.inspect(ids.at(-1)!))?.status,'succeeded');
});
