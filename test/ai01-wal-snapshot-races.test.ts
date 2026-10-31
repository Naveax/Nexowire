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


// Deterministic metadata race between the first lstat() and the actual
// fs.open(). No scheduler timing, physical Agent, or production journal.
async function atPreOpen(file:string,mutate:()=>Promise<void>,
  assertion:()=>Promise<void>){
  const originalOpen=fs.open;
  let triggered=false;
  fs.open=(async(pathArg:Parameters<typeof fs.open>[0],
    flags:Parameters<typeof fs.open>[1],mode?:Parameters<typeof fs.open>[2])=>{
    if(String(pathArg)===file&&flags==='r'){
      triggered=true;
      await mutate();
    }
    return originalOpen(pathArg,flags,mode);
  }) as typeof fs.open;
  try{await assertion();}finally{fs.open=originalOpen;}
  assert.equal(triggered,true,'must intercept the pre-open metadata race');
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

test('stable empty WAL is accepted without writing or creating a database',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nw-ai01-wal-empty-'));
  t.after(()=>fs.rm(dir,{force:true,recursive:true}));
  const db=path.join(dir,'unused.sqlite');
  const wal=db+'-wal';
  await fs.writeFile(wal,Buffer.alloc(0));
  await verifyAgentJournalWal(db);
  assert.equal((await fs.stat(wal)).size,0);
  await assert.rejects(fs.stat(db),{code:'ENOENT'});
});

test('empty WAL cannot silently change pathname identity during early return',async t=>{
  if(process.platform==='win32'){
    t.skip('open-file rename sharing differs on Windows; the positive empty-WAL and in-place races still run');
    return;
  }
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nw-ai01-wal-empty-swap-'));
  t.after(()=>fs.rm(dir,{force:true,recursive:true}));
  const db=path.join(dir,'unused.sqlite');
  const wal=db+'-wal';
  await fs.writeFile(wal,Buffer.alloc(0));
  await fs.writeFile(wal+'.swap',Buffer.alloc(0));
  await atWalStat(wal,1,async()=>{
    await fs.rename(wal,wal+'.old');
    await fs.rename(wal+'.swap',wal);
  },async()=>{
    await assert.rejects(verifyAgentJournalWal(db),
      {code:'AGENT_JOURNAL_WAL_CORRUPT'});
  });
  assert.equal((await fs.stat(wal)).size,0);
});

test('byte-identical WAL pathname replacement is rejected by inode identity',async t=>{
  if(process.platform==='win32'){
    t.skip('open-file rename sharing differs on Windows; existing in-place mutation negatives execute');
    return;
  }
  const f=await fixture(t,true);
  const wal=f.file+'-wal';
  await fs.writeFile(wal+'.swap',f.wal);
  await atWalStat(wal,2,async()=>{
    await fs.rename(wal,wal+'.old');
    await fs.rename(wal+'.swap',wal);
  },async()=>{
    await assert.rejects(verifyAgentJournalWal(f.file),
      {code:'AGENT_JOURNAL_WAL_CORRUPT'});
  });
  assert.deepEqual(await fs.readFile(wal),f.wal,
    'denial must be based on identity, not merely byte differences');
});


test('checksum-valid current WAL with a missing final commit marker fails closed',async t=>{
  const f=await fixture(t,false);
  const tampered=Buffer.from(f.wal);
  const rawPage=tampered.readUInt32BE(8);
  const pageSize=rawPage===1?65536:rawPage;
  const stride=24+pageSize;
  const count=(tampered.length-32)/stride;
  assert.ok(Number.isInteger(count)&&count>=2,
    'fixture must have prior commits and a distinct last transaction');
  const last=32+(count-1)*stride;
  assert.notEqual(tampered.readUInt32BE(last+4),0,
    'the last SQLite-generated frame must originally commit UNKNOWN');
  // Remove only the commit marker; recalculate a fully consistent WAL checksum
  // so a plain checksum-mismatch test cannot satisfy this negative.
  tampered.writeUInt32BE(0,last+4);
  const big=tampered.readUInt32BE(0)===0x377f0683;
  function fold(buffer:Buffer,seed:{s0:number;s1:number}){
    let {s0,s1}=seed;
    assert.equal(buffer.length%8,0);
    for(let offset=0;offset<buffer.length;offset+=8){
      const a=big?buffer.readUInt32BE(offset):buffer.readUInt32LE(offset);
      const b=big?buffer.readUInt32BE(offset+4):buffer.readUInt32LE(offset+4);
      s0=(s0+a+s1)>>>0;
      s1=(s1+b+s0)>>>0;
    }
    return {s0,s1};
  }
  const previous=last-stride;
  let digest={
    s0:tampered.readUInt32BE(previous+16),
    s1:tampered.readUInt32BE(previous+20),
  };
  digest=fold(tampered.subarray(last,last+8),digest);
  digest=fold(tampered.subarray(last+24,last+24+pageSize),digest);
  tampered.writeUInt32BE(digest.s0,last+16);
  tampered.writeUInt32BE(digest.s1,last+20);

  // Independently walk every frame checksum to exclude accidental checksum
  // corruption from the rejection reason. The final frame is well-formed but
  // no longer a COMMIT, so SQLite would not retain that terminal record.
  let checked=fold(tampered.subarray(0,24),{s0:0,s1:0});
  assert.equal(checked.s0,tampered.readUInt32BE(24));
  assert.equal(checked.s1,tampered.readUInt32BE(28));
  for(let i=0;i<count;i++){
    const at=32+i*stride;
    assert.ok(tampered.subarray(at+8,at+16).equals(tampered.subarray(16,24)));
    checked=fold(tampered.subarray(at,at+8),checked);
    checked=fold(tampered.subarray(at+24,at+24+pageSize),checked);
    assert.equal(checked.s0,tampered.readUInt32BE(at+16));
    assert.equal(checked.s1,tampered.readUInt32BE(at+20));
  }
  assert.equal(tampered.readUInt32BE(last+4),0);
  await fs.writeFile(f.file+'-wal',tampered);
  await assert.rejects(verifyAgentJournalWal(f.file),
    {code:'AGENT_JOURNAL_WAL_CORRUPT'});
  assert.deepEqual(await fs.readFile(f.file+'-wal'),tampered);
  assert.deepEqual(await fs.readFile(f.file),f.main);
  assert.deepEqual(await fs.readFile(f.file+'-shm'),f.shm);
});


test('pre-open WAL truncate cannot be mistaken for a stable empty WAL',async t=>{
  const f=await fixture(t,false);
  const wal=f.file+'-wal';
  assert.ok(f.wal.length>32,'fixture must start with a nonempty WAL');
  await atPreOpen(wal,()=>fs.truncate(wal,0),async()=>{
    await assert.rejects(verifyAgentJournalWal(f.file),
      {code:'AGENT_JOURNAL_WAL_CORRUPT'});
  });
  assert.equal((await fs.stat(wal)).size,0);
  assert.deepEqual(await fs.readFile(f.file),f.main);
  assert.deepEqual(await fs.readFile(f.file+'-shm'),f.shm);
});

test('recycled WAL detects byte-identical SHM metadata drift before open',async t=>{
  const f=await fixture(t,true);
  const shm=f.file+'-shm';
  const before=await fs.stat(shm);
  await atPreOpen(shm,async()=>{
    const old=new Date('2000-01-01T00:00:00.000Z');
    await fs.utimes(shm,old,old);
    assert.notEqual((await fs.stat(shm)).mtimeMs,before.mtimeMs,
      'test must modify the metadata but leave SHM contents intact');
  },async()=>{
    await assert.rejects(verifyAgentJournalWal(f.file),
      {code:'AGENT_JOURNAL_WAL_CORRUPT'});
  });
  assert.deepEqual(await fs.readFile(f.file+'-wal'),f.wal);
  assert.deepEqual(await fs.readFile(shm),f.shm,
    'rejection must be based on metadata drift, not byte corruption');
});


test('observed WAL disappearance before open fails with journal corruption code',async t=>{
  const f=await fixture(t,false);
  const wal=f.file+'-wal';
  assert.ok(f.wal.length>32,'the initial WAL must have pending frames');
  await atPreOpen(wal,()=>fs.unlink(wal),async()=>{
    await assert.rejects(verifyAgentJournalWal(f.file),
      {name:'AgentJournalWalError',code:'AGENT_JOURNAL_WAL_CORRUPT'});
  });
  await assert.rejects(fs.stat(wal),{code:'ENOENT'});
  assert.deepEqual(await fs.readFile(f.file),f.main);
  assert.deepEqual(await fs.readFile(f.file+'-shm'),f.shm);
});

test('observed recycled SHM disappearance before open denies journal startup',async t=>{
  const f=await fixture(t,true);
  const shm=f.file+'-shm';
  await atPreOpen(shm,()=>fs.unlink(shm),async()=>{
    await assert.rejects(verifyAgentJournalWal(f.file),
      {name:'AgentJournalWalError',code:'AGENT_JOURNAL_WAL_CORRUPT'});
  });
  await assert.rejects(fs.stat(shm),{code:'ENOENT'});
  assert.deepEqual(await fs.readFile(f.file),f.main);
  assert.deepEqual(await fs.readFile(f.file+'-wal'),f.wal);
});


test('orphaned SHM after WAL loss denies silent UNKNOWN replay-data loss',async t=>{
  const f=await fixture(t,true);
  const wal=f.file+'-wal';
  const shm=f.file+'-shm';
  assert.ok(f.wal.length>32,'SQLite fixture must carry WAL-only UNKNOWN');
  await fs.unlink(wal);
  await assert.rejects(verifyAgentJournalWal(f.file),
    {name:'AgentJournalWalError',code:'AGENT_JOURNAL_WAL_CORRUPT'});
  await assert.rejects(fs.stat(wal),{code:'ENOENT'});
  assert.deepEqual(await fs.readFile(f.file),f.main,
    'preflight must not modify the checkpointed database');
  assert.deepEqual(await fs.readFile(shm),f.shm,
    'orphaned index evidence must remain untouched');
});

test('clean absence of both WAL and SHM permits a new journal',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nw-ai01-no-sidecars-'));
  t.after(()=>fs.rm(dir,{force:true,recursive:true}));
  const file=path.join(dir,'fresh.sqlite');
  await verifyAgentJournalWal(file);
  for(const candidate of [file,file+'-wal',file+'-shm']){
    await assert.rejects(fs.lstat(candidate),{code:'ENOENT'});
  }
});
