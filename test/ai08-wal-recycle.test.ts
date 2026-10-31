/** AI-08 synthetic WAL-only independent regression.
 * Uses disposable SQLite-generated DB/WAL/SHM only; no device journal. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {verifyAgentJournalWal} from '../src/agent/operation-journal-wal.js';

async function reused(t:import('node:test').TestContext){
  const dir=await mkdtemp(path.join(os.tmpdir(),'nx-ai08-wal-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const live=path.join(dir,'generated.sqlite');
  const id=randomUUID();
  const db=new DatabaseSync(live);
  let before!:Buffer,wal!:Buffer,shm!:Buffer;
  try{
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    db.exec('CREATE TABLE receipts (request_id TEXT PRIMARY KEY, state TEXT NOT NULL)');
    const add=db.prepare('INSERT INTO receipts VALUES (?,?)');
    for(let i=0;i<80;i++)add.run('old-'+i,'committed');
    const previous=await readFile(live+'-wal');
    const checkpoint=db.prepare('PRAGMA wal_checkpoint(RESTART)').get()!;
    assert.equal(Number(checkpoint.busy),0);
    assert.equal(Number(checkpoint.log),Number(checkpoint.checkpointed));
    add.run(id,'UNKNOWN');
    [before,wal,shm]=await Promise.all([readFile(live),
      readFile(live+'-wal'),readFile(live+'-shm')]);
    assert.equal(wal.length,previous.length,'fixture must retain allocated old frames');
  }finally{db.close();}
  const page=wal.readUInt32BE(8)===1?65536:wal.readUInt32BE(8);
  const stride=page+24,physical=(wal.length-32)/stride;
  assert.ok(Number.isInteger(physical));
  let current=0;
  while(current<physical&&wal.subarray(32+current*stride+8,
    32+current*stride+16).equals(wal.subarray(16,24)))current++;
  assert.ok(current>0&&current<physical,'fixture must truly recycle WAL');
  const snap=path.join(dir,'snapshot');await mkdir(snap);
  const file=path.join(snap,'operations.sqlite');
  await Promise.all([writeFile(file,before),writeFile(file+'-wal',wal),
    writeFile(file+'-shm',shm)]);
  t.diagnostic('ai08 WAL geometry current='+current+' old='+(physical-current));
  return {file,id,before,wal,shm,current,stride};
}

test('AI-08: valid recycled WAL retains UNKNOWN without rewriting journal bytes',async t=>{
  const f=await reused(t);
  await verifyAgentJournalWal(f.file);
  assert.deepEqual(await readFile(f.file),f.before);
  assert.deepEqual(await readFile(f.file+'-wal'),f.wal);
  assert.deepEqual(await readFile(f.file+'-shm'),f.shm);
  const recovered=new DatabaseSync(f.file);
  try{
    assert.equal(recovered.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
    assert.equal(recovered.prepare('SELECT state FROM receipts WHERE request_id=?')
      .get(f.id)?.state,'UNKNOWN');
    assert.throws(()=>recovered.prepare('INSERT INTO receipts VALUES (?,?)')
      .run(f.id,'committed'),/UNIQUE constraint failed/);
  }finally{recovered.close();}
});

test('AI-08: damaged current WAL frame must deny without self-repair',async t=>{
  const f=await reused(t);
  const damaged=Buffer.from(f.wal);
  damaged[32+24+12]!^=0x80;
  await writeFile(f.file+'-wal',damaged);
  await assert.rejects(verifyAgentJournalWal(f.file),{
    code:'AGENT_JOURNAL_WAL_CORRUPT',
  });
  assert.deepEqual(await readFile(f.file+'-wal'),damaged);
  assert.deepEqual(await readFile(f.file),f.before);
});

test('AI-08: mismatched duplicate WAL-index header cannot truncate replay tombstone',async t=>{
  const f=await reused(t);
  const damaged=Buffer.from(f.shm);
  damaged[48+16]!^=0x01;
  await writeFile(f.file+'-shm',damaged);
  await assert.rejects(verifyAgentJournalWal(f.file),{
    code:'AGENT_JOURNAL_WAL_CORRUPT',
  });
  assert.deepEqual(await readFile(f.file+'-shm'),damaged);
  assert.deepEqual(await readFile(f.file+'-wal'),f.wal);
});


test('AI-08: WAL header checksum tampering denies without rewriting evidence',async t=>{
  const f=await reused(t);
  const damaged=Buffer.from(f.wal);
  // Header checksum field, not a valid SQLite-recalculated checksum.
  damaged[24]!^=0x40;
  await writeFile(f.file+'-wal',damaged);
  await assert.rejects(verifyAgentJournalWal(f.file),{
    code:'AGENT_JOURNAL_WAL_CORRUPT',
  });
  assert.deepEqual(await readFile(f.file+'-wal'),damaged);
  assert.deepEqual(await readFile(f.file+'-shm'),f.shm);
  assert.deepEqual(await readFile(f.file),f.before);
});

test('AI-08: torn recycled WAL allocation tail cannot be silently ignored',async t=>{
  const f=await reused(t);
  const torn=f.wal.subarray(0,f.wal.length-1);
  assert.notEqual(torn.length,f.wal.length);
  await writeFile(f.file+'-wal',torn);
  await assert.rejects(verifyAgentJournalWal(f.file),{
    code:'AGENT_JOURNAL_WAL_CORRUPT',
  });
  assert.deepEqual(await readFile(f.file+'-wal'),torn);
  assert.deepEqual(await readFile(f.file+'-shm'),f.shm);
  assert.deepEqual(await readFile(f.file),f.before);
});

test('AI-08: forged stale-generation first frame cannot replace current UNKNOWN prefix',async t=>{
  const f=await reused(t);
  const damaged=Buffer.from(f.wal);
  const oldFrameOffset=32+f.current*f.stride;
  assert.ok(oldFrameOffset+16<=damaged.length);
  const oldSalt=damaged.subarray(oldFrameOffset+8,oldFrameOffset+16);
  assert.equal(oldSalt.equals(damaged.subarray(16,24)),false,
    'fixture requires a different, genuinely stale generation');
  // The first live frame is now mislabelled as a stale-generation frame,
  // while the database still contains the authoritative UNKNOWN receipt.
  oldSalt.copy(damaged,32+8);
  await writeFile(f.file+'-wal',damaged);
  await assert.rejects(verifyAgentJournalWal(f.file),{
    code:'AGENT_JOURNAL_WAL_CORRUPT',
  });
  assert.deepEqual(await readFile(f.file+'-wal'),damaged);
  assert.deepEqual(await readFile(f.file+'-shm'),f.shm);
  assert.deepEqual(await readFile(f.file),f.before);
});
