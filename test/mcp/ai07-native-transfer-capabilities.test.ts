import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {promises as fs,createReadStream} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {executeCapability} from '../../src/agent/executors.js';
import {PathPolicy} from '../../src/agent/path-policy.js';

test('native Agent capability schemas allow explicit >256 MiB offsets and hash without enlarging payload',{timeout:120_000},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-native-cap-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'large.bin'),policy=new PathPolicy([root]);
  const offset=268435456+1;
  // Virtual-hole fixture only; production positioned writes forbid gaps.
  const fd=await fs.open(file,'wx');
  try{await fd.truncate(offset);await fd.sync();}finally{await fd.close();}
  const wrote=await executeCapability('files.write',{path:file,content:'AB',mode:'write_at',offset_bytes:offset},policy) as {data:{bytesWritten:number}};
  assert.equal(wrote.data.bytesWritten,2);
  const read=await executeCapability('files.read',{path:file,encoding:'base64',offset_bytes:offset,max_bytes:65536},policy) as {data:{size:number,offsetBytes:number,bytesRead:number,content:string}};
  assert.equal(read.data.offsetBytes,offset);
  assert.equal(read.data.size,offset+2);
  assert.equal(read.data.bytesRead,2);
  assert.deepEqual(Buffer.from(read.data.content,'base64'),Buffer.from('AB'));
  await assert.rejects(executeCapability('files.write',{path:file,content:'X',mode:'write_at',offset_bytes:offset+3},policy),/creates a gap/);
  assert.equal((await fs.stat(file)).size,offset+2);
  await assert.rejects(executeCapability('files.read',{path:file,offset_bytes:Number.MAX_SAFE_INTEGER+1},policy));
  await assert.rejects(executeCapability('files.hash',{path:file},policy),/exceeds hash max_bytes/);
  const result=await executeCapability('files.hash',{path:file,max_bytes:offset+2},policy) as {data:{size:number,sha256:string}};
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(file))hash.update(chunk);
  assert.equal(result.data.size,offset+2);
  assert.equal(result.data.sha256,hash.digest('hex'));
});
