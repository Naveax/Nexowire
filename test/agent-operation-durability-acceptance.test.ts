import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdtemp,rm,readFile,copyFile,stat,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AgentOperationJournal} from '../src/agent/operation-journal.js';
import {IdempotencyStore} from '../src/operations/idempotency-store.js';

const fp='1'.repeat(64);
async function sandbox(t:import('node:test').TestContext){
 const dir=await mkdtemp(path.join(os.tmpdir(),'nw-physical-journal-'));
 t.after(async()=>{await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})});
 return {dir,file:path.join(dir,'journal.sqlite')};
}
function getPragmas(file:string){
 const db=new DatabaseSync(file,{readOnly:true});
 try{
  return {
   mode:(db.prepare('PRAGMA journal_mode').get() as {journal_mode:string}).journal_mode,
   sync:(db.prepare('PRAGMA synchronous').get() as {synchronous:number}).synchronous,
   quick:(db.prepare('PRAGMA quick_check').get() as {quick_check:string}).quick_check,
  };
 }finally{db.close()}
}
test('isolated Windows SQLite WAL/FULL, CAS, terminal result and no replay after restart',async t=>{
 const {file}=await sandbox(t);
 const id=randomUUID(),j=new AgentOperationJournal(file);
 try{
  await j.begin(id,fp,'files.write');
  const first=await j.markDispatched(id,fp);
  assert.ok(first.dispatchedAt);
  await assert.rejects(j.markDispatched(id,fp),{code:'AGENT_JOURNAL_DISPATCH_DENIED'});
  await j.complete(id,'succeeded',undefined,{kind:'file_write_ack',verified:false},fp);
  await assert.rejects(j.complete(id,'failed'),{code:'AGENT_JOURNAL_TRANSITION_DENIED'});
  const pragmas=getPragmas(file);
  assert.equal(pragmas.mode,'wal');
  assert.equal(pragmas.sync,2);
  assert.equal(pragmas.quick,'ok');
 }finally{j.close()}
 const again=new AgentOperationJournal(file);
 try{
  const re=(await again.begin(id,fp,'files.write'));
  assert.equal(re.created,false);
  assert.equal(re.record.status,'succeeded');
  await assert.rejects(again.begin(id,'2'.repeat(64),'files.write'),
   {code:'AGENT_JOURNAL_REQUEST_MISMATCH'});
 }finally{again.close()}
});
test('consistent SQLite backup restores terminal tombstones without re-execution',async t=>{
 const {dir,file}=await sandbox(t);
 const original=new AgentOperationJournal(file),id=randomUUID();
 try{
  await original.begin(id,fp,'files.write');
  await original.markDispatched(id,fp);
  await original.complete(id,'succeeded',undefined,{kind:'file_write_ack',verified:false},fp);
 }finally{original.close()}
 const copy=path.join(dir,'verified-backup.sqlite');
 const source=new DatabaseSync(file);
 try{await backup(source,copy)}finally{source.close()}
 const restored=path.join(dir,'restored.sqlite');
 await copyFile(copy,restored);
 const j=new AgentOperationJournal(restored);
 try{
  const read=await j.inspect(id);
  assert.equal(read?.status,'succeeded');
  assert.equal((await j.begin(id,fp,'files.write')).created,false);
 }finally{j.close()}
});
test('old consistent backup loses later mutation: restore must remain an explicit anti-rollback release blocker',async t=>{
 const {dir,file}=await sandbox(t);
 const j=new AgentOperationJournal(file);
 const oldId=randomUUID(),laterId=randomUUID();
 try{
  await j.begin(oldId,fp,'files.write');
  await j.markDispatched(oldId,fp);
  await j.complete(oldId,'succeeded',undefined,undefined,fp);
 }finally{j.close()}
 const saved=path.join(dir,'stale-backup.sqlite');
 const src=new DatabaseSync(file);
 try{await backup(src,saved)}finally{src.close()}
 const newer=new AgentOperationJournal(file);
 try{
  await newer.begin(laterId,fp,'files.write');
  await newer.markDispatched(laterId,fp);
  await newer.complete(laterId,'succeeded',undefined,undefined,fp);
 }finally{newer.close()}
 const restore=path.join(dir,'restored-old.sqlite');
 await copyFile(saved,restore);
 const restored=new AgentOperationJournal(restore);
 try{
  assert.equal((await restored.inspect(laterId)),undefined);
  // EXPECTED UNRESOLVED ROLLBACK VULNERABILITY: an obsolete snapshot accepts
  // a historical operation ID as NEW. We reserve metadata ONLY in this
  // disposable test; never dispatch the side effect or replay an UNKNOWN.
  const unsafe=await restored.begin(laterId,fp,'files.write');
  assert.equal(unsafe.created,true);
  assert.equal((await restored.inspect(oldId))?.status,'succeeded');
  // Release MUST block arbitrary raw restoration unless an independently
  // protected monotonic reservation authority validates the snapshot.
 }finally{restored.close()}
});
test('isolated offline Hub retains UNKNOWN by UUID without contacting Agent',async t=>{
 const {dir}=await sandbox(t),hub=path.join(dir,'hub');
 const a=new IdempotencyStore(hub),key='physical-'+randomUUID();
 const first=await a.begin({
  key,fingerprint:fp,capability:'shell.exec',targetId:'work-pc-isolated',
 });
 await a.complete(key,'unknown');
 const offline=new IdempotencyStore(hub);
 const record=await offline.getByOperationId(first.record.operationId);
 assert.equal(record?.status,'unknown');
 assert.equal(record?.operationId,first.record.operationId);
 assert.equal(record?.targetId,'work-pc-isolated');
});
test('isolated Windows NTFS deny-write blocks journal mutation and leaves record intact',async t=>{
 if(process.platform!=='win32'){t.skip('NTFS ACL only on Windows');return}
 const {file}=await sandbox(t),id=randomUUID();
 const j=new AgentOperationJournal(file);
 try{
  await j.begin(id,fp,'files.write');
  await j.markDispatched(id,fp);
  await j.complete(id,'succeeded',undefined,undefined,fp);
 }finally{j.close()}
 const account=spawnSync('whoami',[],{encoding:'utf8'});
 assert.equal(account.status,0);
 const identity=account.stdout.trim();
 const denied=spawnSync('icacls',[file,'/deny',identity+':(W)'],{encoding:'utf8'});
 if(denied.status!==0)throw new Error('Failed to set isolated NTFS ACL: '+denied.stderr+' '+denied.stdout);
 try{
  const attempt=new AgentOperationJournal(file);
  await assert.rejects(attempt.begin(randomUUID(),fp,'files.write'));
  try{attempt.close()}catch{}
 }finally{
  const reset=spawnSync('icacls',[file,'/remove:d',identity],{encoding:'utf8'});
  assert.equal(reset.status,0,'Must remove isolated ACL denial: '+reset.stderr);
 }
 const read=new AgentOperationJournal(file);
 try{assert.equal((await read.inspect(id))?.status,'succeeded')}
 finally{read.close()}
});
test('cold DB+WAL+SHM backup after isolated forced crash retains terminal and UNKNOWN',async t=>{
 const {dir,file}=await sandbox(t),completed=randomUUID(),pending=randomUUID();
 const src=new URL('../src/agent/operation-journal.ts',import.meta.url).href;
 const code=[
  'import {AgentOperationJournal} from '+JSON.stringify(src)+';',
  'const j=new AgentOperationJournal('+JSON.stringify(file)+');',
  'await j.begin('+JSON.stringify(completed)+','+JSON.stringify(fp)+',"files.write");',
  'await j.markDispatched('+JSON.stringify(completed)+','+JSON.stringify(fp)+');',
  'await j.complete('+JSON.stringify(completed)+',"succeeded",undefined,undefined,'+JSON.stringify(fp)+');',
  'await j.begin('+JSON.stringify(pending)+','+JSON.stringify(fp)+',"shell.exec");',
  'await j.markDispatched('+JSON.stringify(pending)+','+JSON.stringify(fp)+');',
  'console.log("READY");setInterval(()=>{},1000);',
 ].join('\n');
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],
  {cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')});
 await new Promise<void>((resolve,reject)=>{
  let stdout='',stderr='';
  const timer=setTimeout(()=>reject(new Error('Child did not commit: '+stderr)),20000);
  child.stdout?.on('data',x=>{
   stdout+=String(x);
   if(stdout.includes('READY')){clearTimeout(timer);resolve()}
  });
  child.stderr?.on('data',x=>{stderr+=String(x)});
  child.once('error',e=>{clearTimeout(timer);reject(e)});
  child.once('exit',c=>{
   if(!stdout.includes('READY')){
    clearTimeout(timer);reject(new Error('Child exited '+c+': '+stderr))}
  });
 });
 assert.equal(child.kill('SIGKILL'),true);
 await new Promise<void>(resolve=>child.once('exit',()=>resolve()));
 const copied=path.join(dir,'cold.sqlite');
 for(const suffix of ['','-wal','-shm']){
  try{await stat(file+suffix)}
  catch(e){if(suffix==='-shm')continue;throw e}
  await copyFile(file+suffix,copied+suffix);
 }
 const restored=new AgentOperationJournal(copied);
 try{
  assert.equal((await restored.inspect(pending))?.status,'unknown');
  assert.equal((await restored.inspect(completed))?.status,'succeeded');
  assert.equal((await restored.begin(pending,fp,'shell.exec')).created,false);
  assert.equal((await restored.begin(completed,fp,'files.write')).created,false);
 }finally{restored.close()}
});

test('metadata-only quota SQLITE_FULL refuses dispatch under deterministic isolated page cap',async t=>{
 const {file}=await sandbox(t),j=new AgentOperationJournal(file,{maxPageGrowth:0});
 let count=0,full=false;
 try{
  for(let i=0;i<1200;i++){
   try{await j.begin(randomUUID(),fp,'files.write');count++}
   catch(e){
    assert.match(String(e),/SQLITE_FULL|database or disk is full|database full/i);
    full=true;break;
   }
  }
  assert.equal(full,true);
  await assert.rejects(j.markDispatched(randomUUID(),fp));
 }finally{j.close()}
 assert.ok(count<1200);
});
