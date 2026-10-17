import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {executeCapability} from '../src/agent/executors.js';
import {PathPolicy} from '../src/agent/path-policy.js';
import {transferCrossDeviceFile} from '../src/mcp/cross-device-file-transfer.js';
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
test('native ranged reads support files larger than each response cap',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-range-'));
 try{
  const file=path.join(root,'source.bin'),policy=new PathPolicy([root]);
  const b=Buffer.alloc(220*1024);for(let i=0;i<b.length;i++)b[i]=i%239;
  await fs.writeFile(file,b);
  await assert.rejects(executeCapability('files.read',{
    path:file,encoding:'base64',max_bytes:49152
  },policy),/exceeds max_bytes/);
  const p=await executeCapability('files.read',{
    path:file,encoding:'base64',max_bytes:49152,offset_bytes:49000
  },policy) as {data:{size:number,bytesRead:number,offsetBytes:number,content:string}};
  assert.equal(p.data.size,b.length);
  assert.equal(p.data.offsetBytes,49000);
  assert.equal(p.data.bytesRead,49152);
  assert.deepEqual(Buffer.from(p.data.content,'base64'),b.subarray(49000,49000+49152));
  await assert.rejects(executeCapability('files.read',{
    path:file,offset_bytes:b.length+1
  },policy),/offset exceeds file size/);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
test('create and positioned writes cannot overwrite or grow sparse files',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-write-offset-'));
 try{
  const policy=new PathPolicy([root]),p=path.join(root,'target.bin');
  await executeCapability('files.write',{path:p,content:'ABC',mode:'create'},policy);
  await assert.rejects(executeCapability('files.write',{
    path:p,content:'REPLACE',mode:'create'
  },policy),/EEXIST/);
  const first=await executeCapability('files.write',{
    path:p,content:Buffer.from('D').toString('base64'),mode:'write_at',
    offset_bytes:3,encoding:'base64'
  },policy) as {data:{bytesWritten:number}};
  assert.equal(first.data.bytesWritten,1);
  await executeCapability('files.write',{
    path:p,content:'D',mode:'write_at',offset_bytes:3
  },policy);
  assert.equal((await fs.readFile(p)).toString(),'ABCD');
  await assert.rejects(executeCapability('files.write',{
    path:p,content:'X',mode:'write_at',offset_bytes:100
  },policy),/creates a gap/);
  await assert.rejects(executeCapability('files.write',{
    path:p,content:'X',mode:'write_at'
  },policy),/requires an explicit/);
  await assert.rejects(executeCapability('files.write',{
    path:p,content:'X',mode:'append',offset_bytes:2
  },policy),/may only be used/);
  assert.equal((await fs.readFile(p)).toString(),'ABCD');
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
test('atomic publish never overwrites an existing destination',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-atomic-publish-'));
 try{
  const policy=new PathPolicy([root]);
  const stage=path.join(root,'stage.tmp'),dest=path.join(root,'final.bin');
  await fs.writeFile(stage,'NEW PAYLOAD');
  await fs.writeFile(dest,'EXISTING USER FILE');
  await assert.rejects(executeCapability('files.move',{
   source:stage,destination:dest,overwrite:false,atomic_no_overwrite:true
  },policy),/EEXIST/);
  assert.equal(await fs.readFile(dest,'utf8'),'EXISTING USER FILE');
  assert.equal(await fs.readFile(stage,'utf8'),'NEW PAYLOAD');
  await fs.unlink(dest);
  await executeCapability('files.move',{
   source:stage,destination:dest,overwrite:false,atomic_no_overwrite:true
  },policy);
  assert.equal(await fs.readFile(dest,'utf8'),'NEW PAYLOAD');
  await assert.rejects(fs.stat(stage));
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
test('atomic publish is restricted to same-directory regular files',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-atomic-protect-'));
 try{
  const policy=new PathPolicy([root]);
  const parent=path.join(root,'folder');
  await fs.mkdir(parent);
  const src=path.join(root,'src.tmp'),dst=path.join(parent,'dst.bin');
  await fs.writeFile(src,'TEST');
  await assert.rejects(executeCapability('files.move',{
   source:src,destination:dst,overwrite:false,atomic_no_overwrite:true
  },policy),/same source and destination directory/);
  assert.equal(await fs.readFile(src,'utf8'),'TEST');
  await assert.rejects(executeCapability('files.move',{
   source:src,destination:path.join(root,'out.bin'),
   overwrite:true,atomic_no_overwrite:true
  },policy),/overwrite=false/);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
test('full isolated transfer via native agent chunk reads and positional stage writes',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-transfer-native-'));
 const policy=new PathPolicy([root]),src=path.join(root,'source.dat');
 const dst=path.join(root,'final.dat');
 const bytes=Buffer.alloc(223*1024);for(let i=0;i<bytes.length;i++)bytes[i]=i%241;
 try{
  await fs.writeFile(src,bytes);
  let chunks=0;
  const run=async()=>transferCrossDeviceFile(dst,{
   statSource:async()=>{
    const r=await executeCapability('files.stat',{path:src},policy) as {
      data:{type:string,size:number}};
    return r.data;
   },
   hashSource:async()=>{
    const r=await executeCapability('files.hash',{path:src},policy) as {
      data:{sha256:string}};
    return r.data.sha256;
   },
   readSource:async(offset,max)=>{
    const r=await executeCapability('files.read',{
      path:src,encoding:'base64',offset_bytes:offset,max_bytes:max
    },policy) as {data:{size:number,offsetBytes:number,bytesRead:number,content:string}};
    chunks++;
    return {sourceBytes:r.data.size,offsetBytes:r.data.offsetBytes,
      bytesRead:r.data.bytesRead,content:r.data.content};
   },
   writeStage:async(stage,content,offset,first)=>{
    const r=await executeCapability('files.write',{
      path:stage,content,encoding:'base64',mode:first?'create':'write_at',
      ...(first?{}:{offset_bytes:offset})
    },policy) as {data:{bytesWritten:number}};
    return r.data.bytesWritten;
   },
   hashStage:async(stage)=>{
    const r=await executeCapability('files.hash',{path:stage},policy) as {
      data:{sha256:string}};
    return r.data.sha256;
   },
   commitStage:async(stage,destination)=>{
    await executeCapability('files.move',{
      source:stage,destination,overwrite:false,atomic_no_overwrite:true
    },policy);
   },
   cleanupStage:async(stage)=>{
    await executeCapability('files.delete',{path:stage,recursive:false},policy);
   },
  });
  const first=await run();
  assert.equal(first.state,'COMPLETE');
  assert.equal(first.sha256,sha(bytes));
  assert.equal(chunks,5);
  assert.deepEqual(await fs.readFile(dst),bytes);
  await assert.rejects(run(),/(Destination already exists|EEXIST)/);
  assert.deepEqual(await fs.readFile(dst),bytes);
  assert.equal((await fs.readdir(root)).filter(x=>x.includes('.nexowire-upload-')).length,0);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
