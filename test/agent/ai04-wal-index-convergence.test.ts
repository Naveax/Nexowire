import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {endianness,tmpdir} from 'node:os';
import path from 'node:path';
import {verifyAgentJournalWal} from '../../src/agent/operation-journal-wal.js';

const big=endianness()==='BE';
const u32=(b:Buffer,at:number)=>big?b.readUInt32BE(at):b.readUInt32LE(at);
const put=(b:Buffer,at:number,n:number)=>big?b.writeUInt32BE(n,at):b.writeUInt32LE(n,at);
function rechecksum(b:Buffer){
  let a=0,c=0;
  for(let i=0;i<40;i+=8){
    a=(a+u32(b,i)+c)>>>0;
    c=(c+u32(b,i+4)+a)>>>0;
  }
  put(b,40,a);put(b,44,c);
}

async function fixture(t:TestContext){
  const root=await fs.mkdtemp(path.join(tmpdir(),'nw-ai04-index-converge-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const live=path.join(root,'live.sqlite');
  const db=new DatabaseSync(live);
  let main!:Buffer,wal!:Buffer,early!:Buffer,terminal!:Buffer;
  try{
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0;');
    db.exec('CREATE TABLE ledger(id TEXT PRIMARY KEY,status TEXT NOT NULL)');
    db.prepare('INSERT INTO ledger VALUES(?,?)').run('prefix','succeeded');
    early=await fs.readFile(live+'-shm');
    db.prepare('INSERT INTO ledger VALUES(?,?)').run('later','unknown');
    [main,wal,terminal]=await Promise.all([
      fs.readFile(live),fs.readFile(live+'-wal'),fs.readFile(live+'-shm')]);
  }finally{db.close();}
  assert.ok(u32(early,16)>0);
  assert.ok(u32(terminal,16)>u32(early,16));
  assert.deepEqual(early.subarray(32,40),terminal.subarray(32,40));
  assert.deepEqual(early.subarray(0,48),early.subarray(48,96));
  assert.deepEqual(terminal.subarray(0,48),terminal.subarray(48,96));
  const file=path.join(root,'copy.sqlite');
  async function run(initial:Buffer,transitions:Buffer[],expected:'PASS'|'CORRUPT'){
    await fs.writeFile(file,main);
    await fs.writeFile(file+'-wal',wal);
    await fs.writeFile(file+'-shm',initial);
    const real=fs.lstat.bind(fs);
    let reads=0,changed=0,pending=false;
    let last=initial;
    const mock=t.mock.method(fs,'lstat',async(target:string)=>{
      if(target===file+'-wal'&&pending){
        pending=false;
        const next=transitions[changed-1]!;
        const handle=await fs.open(file+'-shm','r+');
        try{await handle.write(next,0,96,0);}finally{await handle.close();}
        last=Buffer.from(last);next.copy(last,0,0,96);
      }
      if(target===file+'-shm'&&++reads%2===0&&changed<transitions.length){
        const before=await real(target);
        await fs.utimes(target,before.atime,new Date(before.mtimeMs+60000));
        const after=await real(target);
        assert.equal(after.dev,before.dev);assert.equal(after.ino,before.ino);
        assert.equal(after.size,before.size);
        assert.notEqual(after.mtimeMs,before.mtimeMs);
        changed++;pending=true;
        return after;
      }
      return real(target);
    });
    try{
      if(expected==='PASS')await verifyAgentJournalWal(file);
      else await assert.rejects(verifyAgentJournalWal(file),{code:'AGENT_JOURNAL_WAL_CORRUPT'});
    }finally{mock.mock.restore();}
    assert.equal(changed,transitions.length);
    assert.equal(pending,false);
    assert.deepEqual(await fs.readFile(file),main);
    assert.deepEqual(await fs.readFile(file+'-wal'),wal);
    assert.deepEqual(await fs.readFile(file+'-shm'),last);
  }
  return {early,terminal,run};
}

test('AI-04 index convergence: authentic earlier commit pair advances to exact durable terminal',async t=>{
  const f=await fixture(t);
  await f.run(f.early,[f.terminal],'PASS');
});
test('AI-04 index convergence: split authentic earlier/current headers converge',async t=>{
  const f=await fixture(t);
  const split=Buffer.from(f.terminal);
  f.early.copy(split,0,0,48);
  await f.run(split,[f.terminal],'PASS');
});
test('AI-04 index convergence: one torn copy cannot erase the other verified prior claim',async t=>{
  const f=await fixture(t);
  const torn=Buffer.from(f.early);torn[0]!^=1;
  await f.run(torn,[f.terminal],'PASS');
});
test('AI-04 index convergence: valid index checksums do not authenticate a false prior commit digest',async t=>{
  const f=await fixture(t);
  const wrong=Buffer.from(f.early);
  const first=wrong.subarray(0,48);
  put(first,24,u32(first,24)^1);rechecksum(first);
  first.copy(wrong,48);
  await f.run(wrong,[f.terminal],'CORRUPT');
});
test('AI-04 index convergence: terminal evidence cannot retreat to an authentic earlier commit',async t=>{
  const f=await fixture(t);
  await f.run(f.terminal,[f.early],'CORRUPT');
});
test('AI-04 index convergence: subsequent retry cannot undo a stronger terminal witness',async t=>{
  const f=await fixture(t);
  await f.run(f.early,[f.terminal,f.early],'CORRUPT');
});
test('AI-04 index convergence: two unverified earlier copies cannot authorize changed evidence',async t=>{
  const f=await fixture(t);
  const invalid=Buffer.from(f.early);invalid[0]!^=1;invalid[48]!^=1;
  await f.run(invalid,[f.terminal],'CORRUPT');
});
