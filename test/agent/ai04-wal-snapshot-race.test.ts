import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {AgentOperationJournal} from '../../src/agent/operation-journal.js';
import {verifyAgentJournalWal} from '../../src/agent/operation-journal-wal.js';

// All fixtures are locally generated disposable SQLite databases. The
// deterministic fault injector changes only the fixture SHM timestamps, not
// the bytes or identity; it never changes a production journal.
async function rootFixture(t:TestContext){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nw-ai04-snapshot-race-'));
  const cleanups:Array<()=>void|Promise<void>>=[];
  t.after(async()=>{
    for(const cleanup of cleanups.reverse())await cleanup();
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  return {root,cleanup:(fn:()=>void|Promise<void>)=>cleanups.push(fn)};
}

type Snapshot={main:Buffer;wal:Buffer;shm:Buffer};
async function snapshot(file:string):Promise<Snapshot>{
  const [main,wal,shm]=await Promise.all([
    fs.readFile(file),fs.readFile(file+'-wal'),fs.readFile(file+'-shm'),
  ]);
  return {main,wal,shm};
}
async function fixture(t:TestContext){
  const {root}=await rootFixture(t);
  const live=path.join(root,'live.sqlite');
  const db=new DatabaseSync(live);
  let empty!:Snapshot,prefix!:Snapshot,hot!:Snapshot,reused!:Snapshot;
  try{
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0;');
    db.exec('CREATE TABLE ledger(request_id TEXT PRIMARY KEY,status TEXT NOT NULL)');
    db.prepare('INSERT INTO ledger VALUES(?,?)').run('old','succeeded');
    assert.equal(Number(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()!.busy),0);
    empty=await snapshot(live);
    assert.equal(empty.wal.length,0);
    db.prepare('INSERT INTO ledger VALUES(?,?)').run('prefix','succeeded');
    prefix=await snapshot(live);
    db.prepare('INSERT INTO ledger VALUES(?,?)').run('later','unknown');
    hot=await snapshot(live);
    assert.ok(hot.wal.length>prefix.wal.length);
    assert.deepEqual(hot.wal.subarray(0,prefix.wal.length),prefix.wal);
    assert.equal(Number(db.prepare('PRAGMA wal_checkpoint(RESTART)').get()!.busy),0);
    db.prepare('INSERT INTO ledger VALUES(?,?)').run('reused','unknown');
    reused=await snapshot(live);
    assert.equal(reused.wal.length,hot.wal.length);
    const pageSize=reused.wal.readUInt32BE(8);
    const frameSize=24+(pageSize===1?65536:pageSize);
    assert.ok(reused.wal.length>=32+2*frameSize);
    assert.ok(!reused.wal.subarray(reused.wal.length-frameSize+8,
      reused.wal.length-frameSize+16).equals(reused.wal.subarray(16,24)),
      'RESTART fixture must retain an old-generation physical frame');
  }finally{db.close();}
  async function copy(name:string,s:Snapshot,wal=s.wal){
    const dir=path.join(root,name);
    await fs.mkdir(dir);
    const file=path.join(dir,'copy.sqlite');
    await fs.writeFile(file,s.main);
    await fs.writeFile(file+'-wal',wal);
    await fs.writeFile(file+'-shm',s.shm);
    return file;
  }
  return {empty,prefix,hot,reused,copy};
}

// Force the same lstat-after-fstat edge as the hosted stack. Preserve
// dev/ino/size and prove that a real timestamp changed. The first SHM lstat
// opens the snapshot; the second is the pathname readback. For ordinary WAL
// each full retry repeats both calls. No injection on WAL checks.
function injectDrift(t:TestContext,file:string,limit:number,onDrift?:()=>Promise<void>){
  const real=fs.lstat.bind(fs);
  let reads=0,changes=0;
  const mock=t.mock.method(fs,'lstat',async(target:string)=>{
    if(target===file+'-shm'){
      reads++;
      if(reads%2===0&&changes<limit){
        const before=await real(target);
        await fs.utimes(target,before.atime,new Date(before.mtimeMs+60000));
        const after=await real(target);
        assert.equal(after.dev,before.dev);
        assert.equal(after.ino,before.ino);
        assert.equal(after.size,before.size);
        assert.notEqual(after.mtimeMs,before.mtimeMs);
        changes++;
        await onDrift?.();
        return after;
      }
    }
    return real(target);
  });
  return {reads:()=>reads,changes:()=>changes,restore:()=>mock.mock.restore()};
}
async function unchanged(file:string,s:Snapshot,wal=s.wal){
  const actual=await snapshot(file);
  assert.deepEqual(actual.main,s.main);
  assert.deepEqual(actual.wal,wal);
  assert.deepEqual(actual.shm,s.shm);
}

test('AI-04 snapshot race: one SHM timestamp drift restarts the full ordinary WAL scan',async t=>{
  const f=await fixture(t);
  const file=await f.copy('intact',f.hot);
  const drift=injectDrift(t,file,1);
  try{await verifyAgentJournalWal(file);}
  finally{drift.restore();}
  assert.equal(drift.changes(),1);
  assert.equal(drift.reads(),4);
  await unchanged(file,f.hot);
});

test('AI-04 snapshot race: persistent metadata drift is bounded UNSTABLE, never IN_USE or success',async t=>{
  const f=await fixture(t);
  const file=await f.copy('persistent',f.hot);
  const drift=injectDrift(t,file,Infinity);
  try{
    await assert.rejects(verifyAgentJournalWal(file),{code:'AGENT_JOURNAL_WAL_UNSTABLE'});
  }finally{drift.restore();}
  assert.equal(drift.changes(),3);
  assert.equal(drift.reads(),6);
  await unchanged(file,f.hot);
});

test('AI-04 snapshot race: fresh scan still denies shortened WAL with retained commit evidence',async t=>{
  const f=await fixture(t);
  const file=await f.copy('shortened',f.hot,f.prefix.wal);
  const drift=injectDrift(t,file,1);
  try{await assert.rejects(verifyAgentJournalWal(file),{code:'AGENT_JOURNAL_WAL_CORRUPT'});}
  finally{drift.restore();}
  assert.equal(drift.changes(),1);
  assert.equal(drift.reads(),4,'must revalidate the stable contradictory index');
  await unchanged(file,f.hot,f.prefix.wal);
});

test('AI-04 snapshot race: new checksum damage between attempts must fail the fresh WAL scan',async t=>{
  const f=await fixture(t);
  const file=await f.copy('checksum',f.hot);
  const damaged=Buffer.from(f.hot.wal);
  damaged[damaged.length-1]!^=1;
  const drift=injectDrift(t,file,1,()=>fs.writeFile(file+'-wal',damaged));
  try{await assert.rejects(verifyAgentJournalWal(file),{code:'AGENT_JOURNAL_WAL_CORRUPT'});}
  finally{drift.restore();}
  assert.equal(drift.changes(),1);
  assert.equal(drift.reads(),2,'second scan must reject WAL checksum before reading SHM');
  await unchanged(file,f.hot,damaged);
});

test('AI-04 snapshot race: frameless WAL retains strict stable index requirement',async t=>{
  const f=await fixture(t);
  const file=await f.copy('empty',f.empty);
  const drift=injectDrift(t,file,1);
  try{await assert.rejects(verifyAgentJournalWal(file),{code:'AGENT_JOURNAL_WAL_CORRUPT'});}
  finally{drift.restore();}
  assert.equal(drift.reads(),2);
  await unchanged(file,f.empty);
});

test('AI-04 snapshot race: retained old-generation WAL retains strict index stability',async t=>{
  const f=await fixture(t);
  const file=await f.copy('reused',f.reused);
  const drift=injectDrift(t,file,1);
  try{await assert.rejects(verifyAgentJournalWal(file),{code:'AGENT_JOURNAL_WAL_CORRUPT'});}
  finally{drift.restore();}
  assert.equal(drift.reads(),2);
  await unchanged(file,f.reused);
});

test('AI-04 snapshot race: actual child owner remains IN_USE after fresh scan, death preserves UNKNOWN',
  {timeout:120000},async t=>{
    const {root,cleanup}=await rootFixture(t);
    const file=path.join(root,'owner.sqlite');
    const id=randomUUID();
    const script=[
      'import {AgentOperationJournal} from '+
        JSON.stringify(new URL('../../src/agent/operation-journal.ts',import.meta.url).href)+';',
      'const journal=new AgentOperationJournal(process.argv[1]);',
      'try {',
      "  await journal.begin(process.argv[2], 'd'.repeat(64), 'files.write');",
      "  process.send?.({ready:true});",
      '} catch(error) {',
      '  process.send?.({error:String(error)});',
      '  process.exit(70);',
      '}',
      'setInterval(()=>{},1000);',
    ].join('\n');
    const worker=spawn(process.execPath,
      ['--import','tsx','--input-type=module','-e',script,file,id],
      {stdio:['ignore','ignore','pipe','ipc']});
    let exited=false,stderr='';
    const closed=new Promise<void>(resolve=>worker.once('close',()=>{exited=true;resolve();}));
    worker.stderr?.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-4000);});
    cleanup(async()=>{if(!exited)worker.kill('SIGKILL');await closed;});
    assert.ok(worker.pid);
    const ready=await new Promise<unknown>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('child startup timeout: '+stderr)),60000);
      worker.once('message',value=>{clearTimeout(timer);resolve(value);});
      worker.once('error',e=>{clearTimeout(timer);reject(e);});
      worker.once('close',(code,signal)=>{
        clearTimeout(timer);reject(new Error('child exited: '+code+'/'+signal+' '+stderr));
      });
    });
    assert.deepEqual(ready,{ready:true});
    const readback=new DatabaseSync(file,{readOnly:true});
    try{
      const lease=readback.prepare('SELECT pid,process_identity FROM agent_operation_owner WHERE id=1').get();
      assert.equal(lease?.pid,worker.pid);
      assert.ok(lease?.process_identity,'actual OS incarnation required');
      assert.equal(readback.prepare('SELECT status FROM agent_operation_journal WHERE request_id=?').get(id)?.status,
        'in_progress');
    }finally{readback.close();}
    const contender=new AgentOperationJournal(file);
    cleanup(()=>contender.close());
    const drift=injectDrift(t,file,1);
    try{await assert.rejects(contender.initialize(),{code:'AGENT_JOURNAL_IN_USE'});}
    finally{drift.restore();}
    assert.equal(drift.changes(),1);
    assert.ok(drift.reads()>=4,'must complete a fresh WAL scan before ownership readback');
    const after=new DatabaseSync(file,{readOnly:true});
    try{
      assert.equal(after.prepare('SELECT status FROM agent_operation_journal WHERE request_id=?').get(id)?.status,
        'in_progress');
      assert.equal(after.prepare('SELECT pid FROM agent_operation_owner WHERE id=1').get()?.pid,worker.pid);
    }finally{after.close();}
    worker.kill('SIGKILL');
    await closed;
    await contender.initialize();
    const recovered=await contender.begin(id,'d'.repeat(64),'files.write');
    assert.equal(recovered.created,false);
    assert.equal(recovered.record.status,'unknown');
    assert.equal(recovered.record.fingerprint,'d'.repeat(64));
    await assert.rejects(contender.begin(id,'e'.repeat(64),'files.write'),
      {code:'AGENT_JOURNAL_REQUEST_MISMATCH'});
  });
