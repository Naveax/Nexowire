import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {verifyAgentJournalWal} from '../../src/agent/operation-journal-wal.js';
import {AgentOperationJournal} from '../../src/agent/operation-journal.js';

async function root(t:TestContext){
  const dir=await fs.mkdtemp(path.join(tmpdir(),'nw-ai04-readback-'));
  const cleanup:Array<()=>void|Promise<void>>=[];
  t.after(async()=>{
    for(const close of cleanup.reverse())await close();
    await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  return {dir,cleanup};
}
const suffixes=['','-wal','-shm'] as const;
async function snapshot(file:string){
  return Promise.all(suffixes.map(s=>fs.readFile(file+s)));
}
async function fixture(t:TestContext){
  const {dir}=await root(t);
  const live=path.join(dir,'live.sqlite');
  const db=new DatabaseSync(live);
  let bytes!:Buffer[];
  try{
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0;');
    db.exec('CREATE TABLE ledger(id TEXT PRIMARY KEY,status TEXT NOT NULL)');
    db.prepare('INSERT INTO ledger VALUES(?,?)').run('reservation','unknown');
    bytes=await snapshot(live);
  }finally{db.close();}
  const file=path.join(dir,'copy.sqlite');
  for(const [i,s] of suffixes.entries())await fs.writeFile(file+s,bytes[i]!);
  assert.ok(bytes[1]!.length>32);
  return {file,bytes};
}

// In an ordinary complete WAL scan, lstat(WAL) occurs before open,
// before index verification, and after index verification. Inject a
// syscall error only at the exact failing third pathname-readback edge.
function fault(t:TestContext,file:string,code:string,limit:number,beforeRetry?:()=>Promise<void>){
  const real=fs.lstat.bind(fs);
  let reads=0,failures=0,pending=false;
  const mock=t.mock.method(fs,'lstat',async(target:string)=>{
    if(target===file+'-wal'){
      if(pending){
        pending=false;
        await beforeRetry?.();
      }
      reads++;
      if(reads%3===0&&failures<limit){
        failures++;pending=true;
        throw Object.assign(new Error('private-path-canary'),{code});
      }
    }
    return real(target);
  });
  return {reads:()=>reads,failures:()=>failures,restore:()=>mock.mock.restore()};
}

test('AI-04 pathname readback: transient final EAGAIN restarts full anchored scan',async t=>{
  const f=await fixture(t);
  const m=fault(t,f.file,'EAGAIN',1);
  try{await verifyAgentJournalWal(f.file);}finally{m.restore();}
  assert.equal(m.failures(),1);assert.equal(m.reads(),6);
  assert.deepEqual(await snapshot(f.file),f.bytes);
});
test('AI-04 pathname readback: persistent EBUSY is bounded UNSTABLE not CORRUPT',async t=>{
  const f=await fixture(t);
  const m=fault(t,f.file,'EBUSY',Infinity);
  try{await assert.rejects(verifyAgentJournalWal(f.file),{
    code:'AGENT_JOURNAL_WAL_UNSTABLE',message:/final pathname readback.*EBUSY/
  });}finally{m.restore();}
  assert.equal(m.failures(),3);assert.equal(m.reads(),9);
  assert.deepEqual(await snapshot(f.file),f.bytes);
});
test('AI-04 pathname readback: ENOENT is not retried into clean startup',async t=>{
  const f=await fixture(t);
  const m=fault(t,f.file,'ENOENT',1);
  try{await assert.rejects(verifyAgentJournalWal(f.file),{
    code:'AGENT_JOURNAL_WAL_CORRUPT',message:/pathname disappeared.*ENOENT/
  });}finally{m.restore();}
  assert.equal(m.reads(),3);assert.deepEqual(await snapshot(f.file),f.bytes);
});
test('AI-04 pathname readback: access denial is unavailable and raw path is redacted',async t=>{
  const f=await fixture(t);
  const m=fault(t,f.file,'EACCES',1);
  try{await assert.rejects(verifyAgentJournalWal(f.file),(e:unknown)=>{
    assert.ok(e instanceof Error);
    assert.equal((e as NodeJS.ErrnoException).code,'AGENT_JOURNAL_UNAVAILABLE');
    assert.match(e.message,/EACCES/);assert.doesNotMatch(e.message,/private-path-canary/);
    return true;
  });}finally{m.restore();}
  assert.equal(m.reads(),3);assert.deepEqual(await snapshot(f.file),f.bytes);
});
test('AI-04 pathname readback: disappeared observed sidecars during retry stay CORRUPT',async t=>{
  const f=await fixture(t);
  const m=fault(t,f.file,'EINTR',1,async()=>{
    await fs.unlink(f.file+'-wal');await fs.unlink(f.file+'-shm');
  });
  try{await assert.rejects(verifyAgentJournalWal(f.file),{code:'AGENT_JOURNAL_WAL_CORRUPT'});}
  finally{m.restore();}
  assert.equal(m.failures(),1);
  assert.deepEqual(await fs.readFile(f.file),f.bytes[0]);
  await assert.rejects(fs.access(f.file+'-wal'),{code:'ENOENT'});
  await assert.rejects(fs.access(f.file+'-shm'),{code:'ENOENT'});
});
test('AI-04 pathname readback: changed WAL after transient failure still denied',async t=>{
  const f=await fixture(t);
  const damaged=Buffer.from(f.bytes[1]!);damaged[damaged.length-1]!^=1;
  const m=fault(t,f.file,'EINTR',1,()=>fs.writeFile(f.file+'-wal',damaged));
  try{await assert.rejects(verifyAgentJournalWal(f.file),{code:'AGENT_JOURNAL_WAL_CORRUPT'});}
  finally{m.restore();}
  assert.equal(m.failures(),1);
  assert.deepEqual(await snapshot(f.file),[f.bytes[0],damaged,f.bytes[2]]);
});
test('AI-04 pathname readback: unavailable without retained index cannot restart scan',async t=>{
  const f=await fixture(t);
  await fs.unlink(f.file+'-shm');
  const m=fault(t,f.file,'EAGAIN',1);
  try{await assert.rejects(verifyAgentJournalWal(f.file),{code:'AGENT_JOURNAL_UNAVAILABLE'});}
  finally{m.restore();}
  assert.equal(m.reads(),3);assert.deepEqual(await fs.readFile(f.file+'-wal'),f.bytes[1]);
  await assert.rejects(fs.access(f.file+'-shm'),{code:'ENOENT'});
});
test('AI-04 pathname readback: real owner plus transient final failure stays IN_USE and death is UNKNOWN',
  {timeout:120000},async t=>{
    const {dir,cleanup}=await root(t);
    const file=path.join(dir,'owner.sqlite'),id=randomUUID();
    const script=[
      'import {AgentOperationJournal} from '+
        JSON.stringify(new URL('../../src/agent/operation-journal.ts',import.meta.url).href)+';',
      'const journal=new AgentOperationJournal(process.argv[1]);',
      // The PID alone does not keep a SQLite handle alive: the -e module
      // and its unreferenced bindings can be collected after evaluation.
      // Root the actual owner for the entire disposable child lifetime.
      'globalThis.__nwHeldJournalFixture=journal;',
      'const announceReady=()=>setImmediate(()=>{',
      '  globalThis.gc();',
      '  setImmediate(()=>{globalThis.gc();process.send?.({ready:true});});',
      '});',
      "try { await journal.begin(process.argv[2],'f'.repeat(64),'files.write'); announceReady(); }",
      "catch(e){process.send?.({error:String(e)});process.exit(70);}",
      'setInterval(()=>{},1000);'
    ].join('\n');
    const child=spawn(process.execPath,['--expose-gc','--import','tsx','--input-type=module','-e',script,file,id],
      {stdio:['ignore','ignore','pipe','ipc']});
    let exited=false,stderr='';
    child.stderr?.on('data',b=>{stderr=(stderr+String(b)).slice(-4000);});
    const closed=new Promise<void>(resolve=>child.once('close',()=>{exited=true;resolve();}));
    cleanup.push(async()=>{if(!exited)child.kill('SIGKILL');await closed;});
    const ready=await new Promise<unknown>((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error('child timeout: '+stderr)),60000);
      child.once('message',v=>{clearTimeout(timeout);resolve(v);});
      child.once('error',e=>{clearTimeout(timeout);reject(e);});
      child.once('close',()=>{clearTimeout(timeout);reject(Error('child closed: '+stderr));});
    });
    assert.deepEqual(ready,{ready:true});
    // The ready message is emitted only after two GC cycles. Require a
    // genuinely open WAL, not merely a still-running child PID.
    assert.equal(child.exitCode,null);
    assert.ok((await fs.stat(file+'-wal')).size>32,'live child must retain committed WAL after GC');
    assert.ok((await fs.stat(file+'-shm')).size>=32768,'live child must retain WAL index after GC');
    const contender=new AgentOperationJournal(file);cleanup.push(()=>contender.close());
    const m=fault(t,file,'EAGAIN',1);
    try{await assert.rejects(contender.initialize(),{code:'AGENT_JOURNAL_IN_USE'});}
    finally{m.restore();}
    assert.equal(m.failures(),1);assert.ok(m.reads()>=6);
    const db=new DatabaseSync(file,{readOnly:true});
    try{
      assert.equal(db.prepare('SELECT pid FROM agent_operation_owner WHERE id=1').get()?.pid,child.pid);
      assert.equal(db.prepare('SELECT status FROM agent_operation_journal WHERE request_id=?').get(id)?.status,'in_progress');
    }finally{db.close();}
    child.kill('SIGKILL');await closed;
    await contender.initialize();
    const replay=await contender.begin(id,'f'.repeat(64),'files.write');
    assert.equal(replay.created,false);assert.equal(replay.record.status,'unknown');
    await assert.rejects(contender.begin(id,'e'.repeat(64),'files.write'),
      {code:'AGENT_JOURNAL_REQUEST_MISMATCH'});
  });
