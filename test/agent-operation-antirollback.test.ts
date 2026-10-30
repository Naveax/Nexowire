import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdtemp,mkdir,readFile,rm,copyFile,rename,unlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AgentOperationJournal} from '../src/agent/operation-journal.js';
import {JournalAuthority,provisionJournalAuthority,
  type AuthorityConfig} from '../src/agent/operation-journal-authority.js';
import {IdempotencyStore} from '../src/operations/idempotency-store.js';

const fp='f'.repeat(64);
async function fixture(t:import('node:test').TestContext){
  const dir=await mkdtemp(path.join(os.tmpdir(),'nw-antirollback-'));
  const journalRoot=path.join(dir,'journal');
  const authorityRoot=path.join(dir,'independent-authority');
  await mkdir(journalRoot);
  await mkdir(authorityRoot);
  const file=path.join(journalRoot,'agent.sqlite');
  const authority:AuthorityConfig={
    file:path.join(authorityRoot,'reservations.sqlite'),
    authorityId:randomUUID(),generation:randomUUID(),
  };
  const all:AgentOperationJournal[]=[];
  const open=(journalFile=file,config=authority)=>{
    const j=new AgentOperationJournal(journalFile,{authority:config});
    all.push(j);return j;
  };
  t.after(async()=>{
    for(const j of all){try{j.close()}catch{}}
    await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:60});
  });
  await provisionJournalAuthority(authority);
  return {dir,file,authority,open};
}
async function perform(j:AgentOperationJournal,id=randomUUID()){
  assert.equal((await j.begin(id,fp,'files.write')).created,true);
  assert.ok((await j.markDispatched(id,fp)).dispatchedAt);
  await j.complete(id,'succeeded',undefined,
    {kind:'file_write_ack',verified:false},fp);
  return id;
}
async function snapshot(file:string,output:string){
  const db=new DatabaseSync(file);
  try{await backup(db,output)}finally{db.close()}
}
test('trusted reservation survives original journal rollback and refuses historical requestId',async t=>{
  const {dir,file,open}=await fixture(t);
  const j=open(),first=await perform(j);
  j.close();
  const stale=path.join(dir,'stale.sqlite');
  await snapshot(file,stale);
  const current=open();const second=await perform(current);
  current.close();
  await copyFile(stale,file);
  const restored=open();
  await assert.rejects(restored.begin(second,fp,'files.write'),
    {code:'AGENT_AUTHORITY_ROLLBACK_DETECTED'});
  await assert.rejects(restored.begin(randomUUID(),fp,'files.write'),
    {code:'AGENT_AUTHORITY_ROLLBACK_DETECTED'});
  // Trusted authority retains second UUID even though local snapshot forgot it.
  assert.equal((await readFile(stale)).length>0,true);
  assert.equal(first!==second,true);
});
test('real child crash and WAL-era rollback fail closed without executing',async t=>{
  const {dir,file,authority,open}=await fixture(t);
  const {spawn}=await import('node:child_process');
  const id1=randomUUID(),id2=randomUUID();
  const source=new URL('../src/agent/operation-journal.ts',import.meta.url).href;
  const script=[
    'import {AgentOperationJournal} from '+JSON.stringify(source)+';',
    'const j=new AgentOperationJournal('+JSON.stringify(file)+
      ',{authority:'+JSON.stringify(authority)+'});',
    'await j.begin('+JSON.stringify(id1)+','+JSON.stringify(fp)+',"files.write");',
    'await j.markDispatched('+JSON.stringify(id1)+','+JSON.stringify(fp)+');',
    'console.log("PHASE_ONE");',
    'await new Promise(r=>process.stdin.once("data",r));',
    'await j.begin('+JSON.stringify(id2)+','+JSON.stringify(fp)+',"files.write");',
    'await j.markDispatched('+JSON.stringify(id2)+','+JSON.stringify(fp)+');',
    'console.log("PHASE_TWO");',
    'setInterval(()=>{},1000);',
  ].join('\n');
  const child=spawn(process.execPath,
    ['--import','tsx','--input-type=module','-e',script],
    {cwd:process.cwd(),stdio:['pipe','pipe','pipe']});
  t.after(()=>{
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  });
  let output='',errorOutput='';
  child.stdout?.on('data',c=>{output+=String(c)});
  child.stderr?.on('data',c=>{errorOutput+=String(c)});
  const phase=async(name:string)=>{
    const end=Date.now()+15000;
    while(!output.includes(name)&&Date.now()<end){
      if(child.exitCode!==null)throw new Error(errorOutput);
      await new Promise(r=>setTimeout(r,50));
    }
    assert.ok(output.includes(name),name+' missing: '+errorOutput);
  };
  await phase('PHASE_ONE');
  const snapshot=path.join(dir,'old-hot-snapshot');
  await mkdir(snapshot);
  for(const suffix of ['','-wal','-shm']){
    try{await copyFile(file+suffix,path.join(snapshot,'journal.sqlite'+suffix))}
    catch(e){if(suffix!=='-shm')throw e}
  }
  child.stdin!.write('CONTINUE\n');
  await phase('PHASE_TWO');
  assert.equal(child.kill('SIGKILL'),true);
  await new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  // Authentic crash recovery preserves the second ID as UNKNOWN.
  const crashed=open();
  assert.equal((await crashed.inspect(id2))?.status,'unknown');
  assert.equal((await crashed.begin(id2,fp,'files.write')).created,false);
  crashed.close();
  // Restore the older DB+WAL(+SHM) set from before the second reservation.
  const destination=path.join(dir,'restored-hot.sqlite');
  for(const suffix of ['','-wal','-shm']){
    try{await copyFile(path.join(snapshot,'journal.sqlite'+suffix),destination+suffix)}
    catch(e){if(suffix!=='-shm')throw e}
  }
  const restored=open(destination);
  await assert.rejects(restored.begin(id2,fp,'files.write'),
    {code:'AGENT_AUTHORITY_ROLLBACK_DETECTED'});
  await assert.rejects(restored.begin(randomUUID(),fp,'files.write'),
    {code:'AGENT_AUTHORITY_ROLLBACK_DETECTED'});
});

test('same UUID CAS, wrong fingerprint, and restart do not create a second reservation',async t=>{
  const {file,authority,open}=await fixture(t);
  const id=randomUUID(),j=open();
  await perform(j,id);
  assert.equal((await j.begin(id,fp,'files.write')).created,false);
  await assert.rejects(j.markDispatched(id,fp),{code:'AGENT_JOURNAL_DISPATCH_DENIED'});
  await assert.rejects(j.begin(id,'a'.repeat(64),'files.write'),
    {code:'AGENT_AUTHORITY_REQUEST_MISMATCH'});
  j.close();
  const next=open();
  assert.equal((await next.begin(id,fp,'files.write')).created,false);
  const a=new JournalAuthority(authority);
  await a.initialize();assert.equal(a.head(),1);a.close();
});
test('missing independent authority file is fail closed on restart',async t=>{
  const {authority,open}=await fixture(t);
  const j=open();
  await perform(j);
  j.close();
  await rename(authority.file,authority.file+'.quarantine');
  const restarted=open();
  await assert.rejects(restarted.begin(randomUUID(),fp,'shell.exec'),
    {code:'AGENT_AUTHORITY_UNAVAILABLE'});
});
test('copied unbound journal cannot bypass a previously used independent epoch',async t=>{
  const {dir,authority,open}=await fixture(t);
  const original=open();
  await perform(original);
  original.close();
  const other=path.join(dir,'copied.sqlite');
  const db=new DatabaseSync(other);db.close();
  const transplanted=open(other);
  await assert.rejects(transplanted.begin(randomUUID(),fp,'files.write'),
    {code:'AGENT_AUTHORITY_MIGRATION_REQUIRED'});
});
test('wrong authority generation or identity cannot silently rejoin old journal',async t=>{
  const {file,authority,open}=await fixture(t);
  const current=open();
  await perform(current);
  current.close();
  const altered=open(file,{...authority,generation:randomUUID()});
  await assert.rejects(altered.begin(randomUUID(),fp,'files.write'),
    {code:'AGENT_AUTHORITY_EPOCH_MISMATCH'});
});
test('authority WAL corruption blocks mutation before journal dispatch',async t=>{
  const {authority,open}=await fixture(t);
  const j=open();await perform(j);j.close();
  await writeFile(authority.file+'-wal',Buffer.from('TORN-WAL'));
  const bad=open();
  await assert.rejects(bad.begin(randomUUID(),fp,'files.write'),
    {code:'AGENT_JOURNAL_WAL_CORRUPT'});
});
test('authority reservation committed before journal failure blocks all replays',async t=>{
  const {file,authority}=await fixture(t);
  const limited=new AgentOperationJournal(file,{maxRecords:1,authority});
  const first=await perform(limited);
  const orphan=randomUUID();
  await assert.rejects(limited.begin(orphan,fp,'files.write'),
    {code:'AGENT_JOURNAL_FULL'});
  await assert.rejects(limited.markDispatched(orphan,fp),
    {code:'AGENT_AUTHORITY_ROLLBACK_DETECTED'});
  limited.close();
  const newJ=new AgentOperationJournal(file,{authority});
  await assert.rejects(newJ.begin(orphan,fp,'files.write'),
    {code:'AGENT_AUTHORITY_ROLLBACK_DETECTED'});
  await assert.rejects(newJ.begin(first,fp,'files.write'),
    {code:'AGENT_AUTHORITY_ROLLBACK_DETECTED'});
});
test('independent authority persists through isolated Hub restart and Hub data loss',async t=>{
  const {dir,open}=await fixture(t);
  const j=open();
  const id=await perform(j);
  j.close();
  const hubDir=path.join(dir,'hub');
  const oldHub=new IdempotencyStore(hubDir);
  const reserve=await oldHub.begin({key:'hub-'+randomUUID(),fingerprint:fp,
    capability:'files.write',targetId:'isolated-device'});
  await oldHub.complete(reserve.record.key,'unknown');
  const hubRestart=new IdempotencyStore(hubDir);
  assert.equal((await hubRestart.getByOperationId(reserve.record.operationId))?.status,
    'unknown');
  await rm(hubDir,{recursive:true,force:true});
  const lostHub=new IdempotencyStore(hubDir);
  assert.equal((await lostHub.getByOperationId(reserve.record.operationId)),undefined);
  const agent=open();
  assert.equal((await agent.begin(id,fp,'files.write')).created,false);
});
test('authority and journal are not silently initialized for pre-existing legacy operations',async t=>{
  const {file,authority}=await fixture(t);
  const legacy=new AgentOperationJournal(file);
  await legacy.begin(randomUUID(),fp,'shell.exec');
  legacy.close();
  const guarded=new AgentOperationJournal(file,{authority});
  await assert.rejects(guarded.initialize(),
    {code:'AGENT_AUTHORITY_MIGRATION_REQUIRED'});
});
test('an authority in the same journal backup directory is rejected',async t=>{
  const {file,authority}=await fixture(t);
  assert.throws(()=>new AgentOperationJournal(file,{
    authority:{...authority,file:path.join(path.dirname(file),'authority.sqlite')},
  }),{code:'AGENT_AUTHORITY_COLOCATED'});
});
test('replacing authority path after open fails closed before new dispatch',async t=>{
  const {authority,open}=await fixture(t);
  const j=open();
  const id=await perform(j);
  // Rename is done exclusively in the disposable test namespace.
  try{await rename(authority.file,authority.file+'.moved')}
  catch(e){
    // Windows NTFS prevents renaming a live SQLite database (EBUSY).
    // This is an OS-level refusal, not proof that Linux can never unlink it.
    if(process.platform==='win32' && (e as NodeJS.ErrnoException).code==='EBUSY'){
      assert.equal((await j.begin(id,fp,'files.write')).created,false);
      return;
    }
    throw e;
  }
  await assert.rejects(j.begin(randomUUID(),fp,'files.write'),
    {code:'AGENT_AUTHORITY_UNAVAILABLE'});
  await assert.rejects(j.markDispatched(id,fp),
    {code:'AGENT_AUTHORITY_UNAVAILABLE'});
});
test('independent authority remains payload-free and stores no commands or tokens',async t=>{
  const {authority,open}=await fixture(t);
  const j=open();
  await perform(j);
  j.close();
  const data=await readFile(authority.file);
  assert.equal(data.includes(Buffer.from('SECRET_TOKEN_NEVER_STORE')),false);
  const db=new DatabaseSync(authority.file,{readOnly:true});
  try{
    const names=(db.prepare('PRAGMA table_info(reservations)').all() as
      Array<{name:string}>).map(x=>x.name).sort();
    assert.deepEqual(names,['capability','fingerprint','request_id','sequence']);
  }finally{db.close()}
});

test('no authority path provisioning during initialize or mutation',async t=>{
  const {dir,file,authority,open}=await fixture(t);
  const wrong={...authority,file:path.join(dir,'does-not-exist.sqlite')};
  const j=open(file,wrong);
  await assert.rejects(j.begin(randomUUID(),fp,'files.write'),
    {code:'AGENT_AUTHORITY_UNAVAILABLE'});
  await assert.rejects(readFile(wrong.file),{code:'ENOENT'});
});
