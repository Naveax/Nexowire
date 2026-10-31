import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {verifyAgentJournalWal} from '../src/agent/operation-journal-wal.js';

// Isolated snapshots only. Never open an Agent's real SQLite journal.
async function fixture(t:import('node:test').TestContext,recycle:boolean){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nw-ai01-wal-'));
  t.after(()=>fs.rm(dir,{force:true,recursive:true}));
  const live=path.join(dir,'live.sqlite');
  const db=new DatabaseSync(live);
  let main!:Buffer,wal!:Buffer,shm!:Buffer;
  try{
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=FULL;');
    db.exec('CREATE TABLE operations(id TEXT PRIMARY KEY,state TEXT NOT NULL)');
    const insert=db.prepare('INSERT INTO operations(id,state) VALUES(?,?)');
    for(let i=0;i<64;i++)insert.run('old-'+i,'committed');
    if(recycle){
      const checkpoint=db.prepare('PRAGMA wal_checkpoint(RESTART)').get()!;
      assert.equal(checkpoint.busy,0);
      insert.run('new-unknown','unknown');
    }else insert.run('new-unknown','unknown');
    [main,wal,shm]=await Promise.all([
      fs.readFile(live),fs.readFile(live+'-wal'),fs.readFile(live+'-shm'),
    ]);
  }finally{db.close();}
  const folder=path.join(dir,'snapshot');
  await fs.mkdir(folder);
  const file=path.join(folder,'operations.sqlite');
  await Promise.all([
    fs.writeFile(file,main),fs.writeFile(file+'-wal',wal),
    fs.writeFile(file+'-shm',shm),
  ]);
  if(recycle){
    const pageSize=wal.readUInt32BE(8)===1?65536:wal.readUInt32BE(8);
    const physical=(wal.length-32)/(24+pageSize);
    const salt=wal.subarray(16,24);
    let current=0;
    while(current<physical&&wal.subarray(32+current*(24+pageSize)+8,
        32+current*(24+pageSize)+16).equals(salt))current++;
    assert.ok(current<physical,'must be authentic SQLite RESTART/reuse');
  }
  return {file,main,wal,shm};
}

async function mutateByte(file:string,offset:number){
  const handle=await fs.open(file,'r+');
  try{
    const byte=Buffer.alloc(1);
    assert.equal((await handle.read(byte,0,1,offset)).bytesRead,1);
    byte[0]=(byte[0]??0)^0x40;
    assert.equal((await handle.write(byte,0,1,offset)).bytesWritten,1);
  }finally{await handle.close();}
}

// A deterministic race barrier at a specified stat() on the already-open
// WAL handle. No sleep, timing window, or installed Agent is involved.
async function atWalStat(walPath:string,number:number,mutate:()=>Promise<void>,
  assertion:()=>Promise<void>){
  const originalOpen=fs.open;
  let triggered=false;
  fs.open=(async(pathArg:Parameters<typeof fs.open>[0],
    flags:Parameters<typeof fs.open>[1],mode?:Parameters<typeof fs.open>[2])=>{
    const handle=await originalOpen(pathArg,flags,mode);
    if(String(pathArg)===walPath&&flags==='r'){
      const originalStat=handle.stat.bind(handle);
      let calls=0;
      handle.stat=(async()=>{
        const result=await originalStat();
        if(++calls===number){
          triggered=true;
          await mutate();
        }
        return result;
      }) as typeof handle.stat;
    }
    return handle;
  }) as typeof fs.open;
  try{await assertion();}finally{fs.open=originalOpen;}
  assert.equal(triggered,true,'must hit the intended race barrier');
}

test('clean hot WAL and authentic recycled WAL remain accepted without mutation',async t=>{
  for(const recycle of [false,true]){
    const f=await fixture(t,recycle);
    await verifyAgentJournalWal(f.file);
    assert.deepEqual(await fs.readFile(f.file+'-wal'),f.wal);
    assert.deepEqual(await fs.readFile(f.file+'-shm'),f.shm);
  }
});

test('late in-place WAL header rewrite cannot bypass finished frame scan',async t=>{
  const f=await fixture(t,false);
  await atWalStat(f.file+'-wal',2,()=>mutateByte(f.file+'-wal',24),async()=>{
    await assert.rejects(verifyAgentJournalWal(f.file),
      {code:'AGENT_JOURNAL_WAL_CORRUPT'});
  });
  const changed=await fs.readFile(f.file+'-wal');
  assert.notDeepEqual(changed,f.wal);
  assert.deepEqual(await fs.readFile(f.file+'-shm'),f.shm);
});

test('SHM changed after both index validations still fails closed',async t=>{
  const f=await fixture(t,true);
  await atWalStat(f.file+'-wal',3,()=>mutateByte(f.file+'-shm',16),async()=>{
    await assert.rejects(verifyAgentJournalWal(f.file),
      {code:'AGENT_JOURNAL_WAL_CORRUPT'});
  });
  assert.deepEqual(await fs.readFile(f.file+'-wal'),f.wal);
});

test('replaced WAL pathname cannot borrow verification of the previous inode',async t=>{
  if(process.platform==='win32'){
    t.skip('rename of an open WAL has platform-dependent sharing semantics; in-place race runs on Windows');
    return;
  }
  const f=await fixture(t,false);
  const walPath=f.file+'-wal';
  const staged=walPath+'.replacement';
  const replacement=Buffer.from(f.wal);
  replacement[24]=(replacement[24]??0)^0x40;
  await fs.writeFile(staged,replacement);
  await atWalStat(walPath,2,async()=>{
    await fs.rename(walPath,walPath+'.original');
    await fs.rename(staged,walPath);
  },async()=>{
    await assert.rejects(verifyAgentJournalWal(f.file),
      {code:'AGENT_JOURNAL_WAL_CORRUPT'});
  });
  assert.deepEqual(await fs.readFile(walPath),replacement);
});

test('recycled WAL rejects a physically truncated retained allocation frame',async t=>{
  const f=await fixture(t,true);
  const damaged=f.wal.subarray(0,f.wal.length-17);
  await fs.writeFile(f.file+'-wal',damaged);
  await assert.rejects(verifyAgentJournalWal(f.file),
    {code:'AGENT_JOURNAL_WAL_CORRUPT'});
  assert.deepEqual(await fs.readFile(f.file+'-wal'),damaged);
  assert.deepEqual(await fs.readFile(f.file+'-shm'),f.shm);
});

test('recycled WAL rejects a partial appended physical frame',async t=>{
  const f=await fixture(t,true);
  const damaged=Buffer.concat([f.wal,Buffer.from([0x57,0x41,0x4c])]);
  await fs.writeFile(f.file+'-wal',damaged);
  await assert.rejects(verifyAgentJournalWal(f.file),
    {code:'AGENT_JOURNAL_WAL_CORRUPT'});
  assert.deepEqual(await fs.readFile(f.file+'-wal'),damaged);
  assert.deepEqual(await fs.readFile(f.file+'-shm'),f.shm);
});

test('current-generation salt tampering in recycled WAL remains fail closed',async t=>{
  const f=await fixture(t,true);
  const damaged=Buffer.from(f.wal);
  damaged[32+8]=(damaged[32+8]??0)^0x40;
  await fs.writeFile(f.file+'-wal',damaged);
  await assert.rejects(verifyAgentJournalWal(f.file),
    {code:'AGENT_JOURNAL_WAL_CORRUPT'});
  assert.deepEqual(await fs.readFile(f.file+'-wal'),damaged);
  assert.deepEqual(await fs.readFile(f.file+'-shm'),f.shm);
});

test('recycled WAL preflight preserves WAL-only UNKNOWN on disposable SQLite reopen',async t=>{
  const f=await fixture(t,true);
  await verifyAgentJournalWal(f.file);
  const db=new DatabaseSync(f.file);
  try{
    const integrity=db.prepare('PRAGMA integrity_check').get() as
      {integrity_check?:string}|undefined;
    assert.equal(integrity?.integrity_check,'ok');
    const row=db.prepare('SELECT state FROM operations WHERE id=?')
      .get('new-unknown') as {state:string}|undefined;
    assert.equal(row?.state,'unknown');
    assert.equal(db.prepare('SELECT count(*) AS count FROM operations')
      .get()!.count,65);
    assert.throws(()=>db.prepare('INSERT INTO operations VALUES(?,?)')
      .run('new-unknown','committed'),/UNIQUE constraint failed/);
  }finally{db.close();}
});
