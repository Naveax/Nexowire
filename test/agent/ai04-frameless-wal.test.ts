import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {verifyAgentJournalWal} from '../../src/agent/operation-journal-wal.js';

type Snapshot={main:Buffer;wal:Buffer;shm:Buffer};
const u32=(bytes:Buffer,offset:number)=>os.endianness()==='BE'?
  bytes.readUInt32BE(offset):bytes.readUInt32LE(offset);

async function snapshot(file:string):Promise<Snapshot>{
  const [main,wal,shm]=await Promise.all([
    readFile(file),readFile(file+'-wal'),readFile(file+'-shm'),
  ]);
  return {main,wal,shm};
}

async function fixture(t:import('node:test').TestContext){
  const root=await mkdtemp(path.join(os.tmpdir(),'nw-ai04-frameless-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const live=path.join(root,'live.sqlite');
  let db:DatabaseSync|undefined=new DatabaseSync(live);
  let empty!:Snapshot,prefix!:Snapshot,hot!:Snapshot,fresh!:Snapshot;
  try{
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0;');
    db.exec('CREATE TABLE ledger(request_id TEXT PRIMARY KEY,status TEXT NOT NULL)');
    db.prepare('INSERT INTO ledger VALUES(?,?)').run('old','succeeded');
    const cp=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()!;
    assert.equal(Number(cp.busy),0);
    empty=await snapshot(live);
    assert.equal(empty.wal.length,0,'authentic TRUNCATE empties the WAL');
    assert.equal(u32(empty.shm,16),0);
    db.prepare('INSERT INTO ledger VALUES(?,?)').run('prefix-only','succeeded');
    prefix=await snapshot(live);
    db.prepare('INSERT INTO ledger VALUES(?,?)').run('wal-only','unknown');
    hot=await snapshot(live);
    assert.ok(hot.wal.length>prefix.wal.length);
    assert.deepEqual(hot.wal.subarray(0,prefix.wal.length),prefix.wal);
    assert.ok(u32(hot.shm,16)>u32(prefix.shm,16));
    assert.ok(hot.wal.length>32);
    assert.ok(u32(hot.shm,16)>0,'authentic index must report committed WAL frames');
    assert.equal(u32(hot.shm,96),0,'the new row must not be backfilled into the base');
    db.close();
    db=undefined;
    db=new DatabaseSync(live);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger').get()!.n,3);
    fresh=await snapshot(live);
    assert.equal(fresh.wal.length,0,'fresh read on cleanly closed WAL-mode DB');
    assert.equal(u32(fresh.shm,16),0);
  }finally{db?.close();}
  async function copy(name:string,s:Snapshot,wal=s.wal,shm:Buffer|null=s.shm){
    const dir=path.join(root,name);
    await mkdir(dir);
    const file=path.join(dir,'copy.sqlite');
    await writeFile(file,s.main);
    await writeFile(file+'-wal',wal);
    if(shm!==null)await writeFile(file+'-shm',shm);
    return file;
  }
  return {copy,empty,prefix,hot,fresh};
}

async function unchanged(file:string,s:Snapshot,wal=s.wal,shm:Buffer|null=s.shm){
  assert.deepEqual(await readFile(file),s.main);
  assert.deepEqual(await readFile(file+'-wal'),wal);
  if(shm===null)await assert.rejects(access(file+'-shm'),{code:'ENOENT'});
  else assert.deepEqual(await readFile(file+'-shm'),shm);
}

test('AI-04 frameless WAL: authentic SQLite TRUNCATE index permits empty WAL unchanged',async t=>{
  const f=await fixture(t);
  const file=await f.copy('truncate',f.empty);
  await verifyAgentJournalWal(file);
  await unchanged(file,f.empty);
});

test('AI-04 frameless WAL: fresh clean WAL-mode read permits zero-frame initialized index',async t=>{
  const f=await fixture(t);
  const file=await f.copy('fresh',f.fresh);
  await verifyAgentJournalWal(file);
  await unchanged(file,f.fresh);
});

test('AI-04 frameless WAL: clean empty allocation without index remains legitimate',async t=>{
  const f=await fixture(t);
  const file=await f.copy('no-index',f.empty,f.empty.wal,null);
  await verifyAgentJournalWal(file);
  await unchanged(file,f.empty,f.empty.wal,null);
});

for(const length of [0,32]){
  test('AI-04 frameless WAL: '+length+'-byte truncation contradicting committed index is denied unchanged',async t=>{
    const f=await fixture(t);
    const genuine=await f.copy('genuine',f.hot);
    await verifyAgentJournalWal(genuine);
    await unchanged(genuine,f.hot);
    const wal=Buffer.from(f.hot.wal.subarray(0,length));
    const file=await f.copy('truncated',f.hot,wal);
    // SQLite's own quick_check is not a no-replay oracle. On a separate
    // disposable copy, SQLite can silently reopen the checkpointed base.
    const oracleFile=await f.copy('sqlite-oracle',f.hot,wal);
    const oracle=new DatabaseSync(oracleFile);
    try{
      assert.equal(oracle.prepare('PRAGMA quick_check').get()!.quick_check,'ok');
      assert.equal(oracle.prepare('SELECT status FROM ledger WHERE request_id=?')
        .get('wal-only'),undefined,'the committed WAL-only tombstone would be lost');
      assert.equal(oracle.prepare('SELECT status FROM ledger WHERE request_id=?')
        .get('old')!.status,'succeeded');
    }finally{oracle.close();}
    await assert.rejects(verifyAgentJournalWal(file),{code:'AGENT_JOURNAL_WAL_CORRUPT'});
    await unchanged(file,f.hot,wal);
  });
}

test('AI-04 frameless WAL: disagreeing index headers do not authorize empty WAL recovery',async t=>{
  const f=await fixture(t);
  const shm=Buffer.from(f.empty.shm);
  shm[48+16]!^=1;
  const file=await f.copy('disagree',f.empty,f.empty.wal,shm);
  await assert.rejects(verifyAgentJournalWal(file),{code:'AGENT_JOURNAL_WAL_CORRUPT'});
  await unchanged(file,f.empty,f.empty.wal,shm);
});

// A complete older commit is still a lossy prefix when the retained index
// of that same WAL generation reports a subsequent committed transaction.
test('AI-04 frameless WAL: complete committed prefix cannot hide a later indexed commit',async t=>{
  const f=await fixture(t);
  const file=await f.copy('prefix',f.hot,f.prefix.wal);
  const oracleFile=await f.copy('prefix-oracle',f.hot,f.prefix.wal);
  const oracle=new DatabaseSync(oracleFile);
  try{
    assert.equal(oracle.prepare('PRAGMA quick_check').get()!.quick_check,'ok');
    assert.equal(oracle.prepare('SELECT status FROM ledger WHERE request_id=?')
      .get('prefix-only')!.status,'succeeded');
    assert.equal(oracle.prepare('SELECT status FROM ledger WHERE request_id=?')
      .get('wal-only'),undefined);
  }finally{oracle.close();}
  await assert.rejects(verifyAgentJournalWal(file),{code:'AGENT_JOURNAL_WAL_CORRUPT'});
  await unchanged(file,f.hot,f.prefix.wal);
});

test('AI-04 frameless WAL: full committed WAL can legitimately be ahead of stale index',async t=>{
  const f=await fixture(t);
  const file=await f.copy('lagging-index',f.hot,f.hot.wal,f.prefix.shm);
  await verifyAgentJournalWal(file);
  await unchanged(file,f.hot,f.hot.wal,f.prefix.shm);
});

test('AI-04 frameless WAL: no-history zero-filled index with empty WAL is accepted unchanged',async t=>{
  const f=await fixture(t);
  const shm=Buffer.alloc(f.empty.shm.length);
  const file=await f.copy('uninitialized',f.empty,f.empty.wal,shm);
  await verifyAgentJournalWal(file);
  await unchanged(file,f.empty,f.empty.wal,shm);
});

test('AI-04 frameless WAL: nonzero backfill counter contradicts zero-frame index',async t=>{
  const f=await fixture(t);
  const shm=Buffer.from(f.empty.shm);
  if(os.endianness()==='BE')shm.writeUInt32BE(1,96);
  else shm.writeUInt32LE(1,96);
  const file=await f.copy('backfill',f.empty,f.empty.wal,shm);
  await assert.rejects(verifyAgentJournalWal(file),{code:'AGENT_JOURNAL_WAL_CORRUPT'});
  await unchanged(file,f.empty,f.empty.wal,shm);
});


// Model interruption between the two index-header copies using only real
// SQLite-generated previous/current headers from the same WAL generation.
// Neither copy is forged, and the genuine full WAL must remain readable.
for(const offset of [0,48]){
  test('AI-04 WAL: split index header at '+offset+' cannot hide later committed history',async t=>{
    const f=await fixture(t);
    assert.deepEqual(f.prefix.shm.subarray(32,40),f.hot.shm.subarray(32,40));
    const shm=Buffer.from(f.hot.shm);
    f.prefix.shm.copy(shm,offset,0,48);
    assert.notDeepEqual(shm.subarray(0,48),shm.subarray(48,96));
    const file=await f.copy('split-prefix',f.hot,f.prefix.wal,shm);
    const oracleFile=await f.copy('split-oracle',f.hot,f.prefix.wal,shm);
    const oracle=new DatabaseSync(oracleFile);
    try{
      assert.equal(oracle.prepare('PRAGMA quick_check').get()!.quick_check,'ok');
      assert.equal(oracle.prepare('SELECT status FROM ledger WHERE request_id=?')
        .get('wal-only'),undefined);
    }finally{oracle.close();}
    await assert.rejects(verifyAgentJournalWal(file),{code:'AGENT_JOURNAL_WAL_CORRUPT'});
    await unchanged(file,f.hot,f.prefix.wal,shm);
  });
  test('AI-04 WAL: split index header at '+offset+' permits intact full WAL unchanged',async t=>{
    const f=await fixture(t);
    const shm=Buffer.from(f.hot.shm);
    f.prefix.shm.copy(shm,offset,0,48);
    assert.notDeepEqual(shm.subarray(0,48),shm.subarray(48,96));
    const file=await f.copy('split-intact',f.hot,f.hot.wal,shm);
    await verifyAgentJournalWal(file);
    await unchanged(file,f.hot,f.hot.wal,shm);
  });
}
