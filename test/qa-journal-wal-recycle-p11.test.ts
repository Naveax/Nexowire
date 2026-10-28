import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {verifyAgentJournalWal} from '../src/agent/operation-journal-wal.js';

// #11 regression for the Naveax 1.0.7 startup incident. All data below is
// generated in a disposable directory by SQLite itself. No uploaded journal,
// production credential, external authority, native effect or device is used.
async function fixture(t:import('node:test').TestContext, recycle:boolean) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'nw-qa-wal-recycle-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const live=path.join(dir,'live.sqlite');
  const db=new DatabaseSync(live);
  const newId=randomUUID();
  let main!:Buffer,wal!:Buffer,shm!:Buffer,expected!:string;
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0;');
    db.exec('CREATE TABLE ledger(operation_id TEXT PRIMARY KEY,status TEXT NOT NULL)');
    const insert=db.prepare('INSERT INTO ledger(operation_id,status) VALUES(?,?)');
    for(let i=0;i<64;i++)insert.run('synthetic-old-'+String(i).padStart(3,'0'),'succeeded');
    const oldWal=await readFile(live+'-wal');
    if(recycle) {
      const checkpoint=db.prepare('PRAGMA wal_checkpoint(RESTART)').get()!;
      assert.equal(Number(checkpoint.busy),0,'fixture RESTART checkpoint must complete');
      assert.equal(Number(checkpoint.log),Number(checkpoint.checkpointed));
    }
    insert.run(newId,'unknown');
    expected=JSON.stringify(db.prepare('SELECT operation_id,status FROM ledger ORDER BY operation_id').all());
    [main,wal,shm]=await Promise.all([
      readFile(live),readFile(live+'-wal'),readFile(live+'-shm'),
    ]);
    if(recycle)assert.equal(wal.length,oldWal.length,'SQLite retains the old physical allocation');
  } finally {
    db.close();
  }
  const pageSize=wal.readUInt32BE(8)===1?65536:wal.readUInt32BE(8);
  const frameBytes=24+pageSize;
  assert.equal((wal.length-32)%frameBytes,0);
  const physicalFrames=(wal.length-32)/frameBytes;
  const salt=wal.subarray(16,24);
  let currentFrames=0;
  while(currentFrames<physicalFrames&&
      wal.subarray(32+currentFrames*frameBytes+8,32+currentFrames*frameBytes+16).equals(salt))
    currentFrames++;
  assert.ok(currentFrames>0);
  assert.notEqual(wal.readUInt32BE(32+(currentFrames-1)*frameBytes+4),0,
    'current-generation prefix ends at a committed transaction');
  if(recycle) {
    assert.ok(currentFrames<physicalFrames,'fixture must actually contain old-generation frames');
    const oldSalt=wal.subarray(32+currentFrames*frameBytes+8,32+currentFrames*frameBytes+16);
    assert.equal((oldSalt.readUInt32BE(0)+1)>>>0,salt.readUInt32BE(0));
    for(let i=currentFrames;i<physicalFrames;i++)
      assert.ok(wal.subarray(32+i*frameBytes+8,32+i*frameBytes+16).equals(oldSalt));
  } else assert.equal(currentFrames,physicalFrames);
  const copy=path.join(dir,'snapshot');
  await mkdir(copy);
  const file=path.join(copy,'operations.sqlite');
  await Promise.all([
    writeFile(file,main),writeFile(file+'-wal',wal),writeFile(file+'-shm',shm),
  ]);
  t.diagnostic('SQLite-generated WAL: current='+currentFrames+', old='+(physicalFrames-currentFrames));
  return {dir,file,main,wal,shm,expected,newId};
}

async function unchanged(f:Awaited<ReturnType<typeof fixture>>) {
  assert.deepEqual(await readFile(f.file),f.main);
  assert.deepEqual(await readFile(f.file+'-wal'),f.wal);
  assert.deepEqual(await readFile(f.file+'-shm'),f.shm);
}

test('ordinary SQLite-generated hot WAL passes without modifying its files',async t=>{
  const f=await fixture(t,false);
  await verifyAgentJournalWal(f.file);
  await unchanged(f);
});

test('SQLite independently recovers recycled WAL including the WAL-only UNKNOWN operation',async t=>{
  const f=await fixture(t,true);
  const baseOnly=path.join(f.dir,'base-only.sqlite');
  await writeFile(baseOnly,f.main);
  const base=new DatabaseSync(baseOnly);
  try {
    assert.equal(base.prepare('SELECT status FROM ledger WHERE operation_id=?').get(f.newId),undefined,
      'the UNKNOWN record must be in the new WAL, not in the checkpointed base');
  } finally { base.close(); }
  const recovered=new DatabaseSync(f.file);
  try {
    assert.equal(recovered.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
    assert.equal(JSON.stringify(recovered.prepare('SELECT operation_id,status FROM ledger ORDER BY operation_id').all()),f.expected);
    assert.equal(recovered.prepare('SELECT status FROM ledger WHERE operation_id=?').get(f.newId)!.status,'unknown');
    assert.throws(()=>recovered.prepare('INSERT INTO ledger VALUES(?,?)').run(f.newId,'succeeded'),
      /UNIQUE constraint failed/,'retained operation ID remains unique');
    assert.equal(recovered.prepare('SELECT status FROM ledger WHERE operation_id=?').get(f.newId)!.status,'unknown');
  } finally { recovered.close(); }
});

test('preflight must accept SQLite-authentic committed prefix with retained prior-generation WAL tail',async t=>{
  const f=await fixture(t,true);
  const outcome=await verifyAgentJournalWal(f.file).then(
    ()=>({accepted:true,code:null}),
    (error:unknown)=>({accepted:false,code:(error as {code?:string}).code??'UNKNOWN'}),
  );
  await unchanged(f);
  assert.deepEqual(outcome,{accepted:true,code:null},
    'a real RESTART/reuse WAL must not prevent Agent startup; never delete the WAL to bypass this assertion');
});

test('current-generation checksum damage in a recycled WAL still fails closed without changing files',async t=>{
  const f=await fixture(t,true);
  const damaged=Buffer.from(f.wal);
  damaged[32+24+47]!^=0x40;
  await writeFile(f.file+'-wal',damaged);
  await assert.rejects(verifyAgentJournalWal(f.file),{code:'AGENT_JOURNAL_WAL_CORRUPT'});
  assert.deepEqual(await readFile(f.file+'-wal'),damaged);
  assert.deepEqual(await readFile(f.file),f.main);
  assert.deepEqual(await readFile(f.file+'-shm'),f.shm);
});
