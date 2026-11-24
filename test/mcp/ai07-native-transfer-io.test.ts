import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {hashNativeTransferFile,readNativeTransferRange,nativeHashPolicy,
  NATIVE_MAX_FILE_OFFSET,NATIVE_MAX_READ_BYTES,NATIVE_DEFAULT_HASH_POLICY_BYTES}
  from '../../src/agent/native-transfer-io.js';

async function fixture(t:import('node:test').TestContext){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nx-native-large-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  return path.join(dir,'fixture.bin');
}
test('native hash policy is explicitly provisioned, not a fixed 256 MiB ceiling',()=>{
  assert.equal(nativeHashPolicy('1073741825'),1073741825);
  assert.equal(nativeHashPolicy(String(NATIVE_MAX_FILE_OFFSET)),NATIVE_MAX_FILE_OFFSET);
  assert.ok(NATIVE_DEFAULT_HASH_POLICY_BYTES>1073741825);
  for(const v of ['', '0','-1','1.5','1e9','9007199254740992',' 5'])
    assert.throws(()=>nativeHashPolicy(v),/Invalid native file hash policy/);
});
test('legacy full read and per-response bounds remain fail closed',async t=>{
  const file=await fixture(t);
  await fs.writeFile(file,'abc');
  assert.deepEqual((await readNativeTransferRange(file,undefined,3)).content,Buffer.from('abc'));
  await assert.rejects(readNativeTransferRange(file,undefined,2),/exceeds max_bytes/);
  await assert.rejects(readNativeTransferRange(file,4,1),/offset exceeds file size/);
  await assert.rejects(readNativeTransferRange(file,0,NATIVE_MAX_READ_BYTES+1),/Invalid bounded read/);
  await assert.rejects(readNativeTransferRange(file,NATIVE_MAX_FILE_OFFSET+1,1),/Invalid read offset/);
  assert.equal((await readNativeTransferRange(file,3,1)).bytesRead,0);
});
test('large range reads and SHA-256 cross the 1 GiB boundary using bounded I/O',{timeout:120_000},async t=>{
  const file=await fixture(t),size=1024**3+1;
  // A sparse *test fixture* only. Production writes still reject gaps.
  const fd=await fs.open(file,'wx');
  try{
    await fd.truncate(size);
    await fd.write(Buffer.from([0x7a]),0,1,size-1);
    await fd.sync();
  }finally{await fd.close();}
  const last=await readNativeTransferRange(file,size-2,64*1024);
  assert.equal(last.size,size);
  assert.equal(last.offsetBytes,size-2);
  assert.equal(last.bytesRead,2);
  assert.deepEqual(last.content,Buffer.from([0,0x7a]));
  const boundary=await readNativeTransferRange(file,268435456+1,64);
  assert.equal(boundary.bytesRead,64);
  assert.deepEqual(boundary.content,Buffer.alloc(64));
  await assert.rejects(hashNativeTransferFile(file,268435456),/exceeds hash max_bytes/);
  await assert.rejects(hashNativeTransferFile(file,size,size-1),/exceeds native file hash policy/);
  const expected=createHash('sha256');
  const zeros=Buffer.alloc(1024*1024);
  for(let i=0;i<1024;i++)expected.update(zeros);
  expected.update(Buffer.from([0x7a]));
  const actual=await hashNativeTransferFile(file,size);
  assert.equal(actual.size,size);
  assert.equal(actual.sha256,expected.digest('hex'));
});
test('empty hash and bounded ordinary file digest are correct',async t=>{
  const file=await fixture(t);
  await fs.writeFile(file,Buffer.alloc(0));
  assert.equal((await hashNativeTransferFile(file,1)).sha256,createHash('sha256').digest('hex'));
  await fs.writeFile(file,'exact');
  assert.equal((await hashNativeTransferFile(file,5)).sha256,createHash('sha256').update('exact').digest('hex'));
  await assert.rejects(hashNativeTransferFile(file,4),/exceeds hash max_bytes/);
});
test('a real file mutation between pinned read and pathname recheck is rejected',async t=>{
  const file=await fixture(t);
  await fs.writeFile(file,'original');
  const lstat=fs.lstat;
  let calls=0;
  t.mock.method(fs,'lstat',(async(...args:unknown[])=>{
    if(args[0]===file&&++calls===2)await fs.writeFile(file,'mutated-content');
    return Reflect.apply(lstat,fs,args);
  }) as typeof fs.lstat);
  await assert.rejects(hashNativeTransferFile(file,100),/File changed during pinned read/);
  assert.equal(calls,2);
});
