import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeCapability, normalizeAgentError } from '../src/agent/executors.js';
import { PathPolicy } from '../src/agent/path-policy.js';

const CHUNK = 64 * 1024;
const MiB = 1024 * 1024;
const sha = (x: Buffer) => createHash('sha256').update(x).digest('hex');
async function temporary(t: import('node:test').TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-bigfile-agent-'));
  t.after(async () => { await fs.rm(dir,{recursive:true,force:true}); });
  return { dir, policy: new PathPolicy([dir]) };
}
async function cmd(capability:string,input: Record<string,unknown>,policy:PathPolicy) {
  const response = await executeCapability(capability,input,policy) as {data:Record<string,unknown>};
  return response.data;
}
async function uploadBytes(
  t: import('node:test').TestContext,size:number,
) {
  const {dir,policy}=await temporary(t);
  const stage=path.join(dir,'final.bin.nexowire-upload-'+randomUUID()+'.tmp');
  const dst=path.join(dir,'final.bin');
  const original=Buffer.alloc(size);
  for(let i=0;i<size;i++) original[i]=(i*53+i%17)%256;
  await cmd('files.write',{path:stage,content:'',mode:'create'},policy);
  for(let off=0;off<size;off+=CHUNK) {
    const chunk=original.subarray(off,Math.min(size,off+CHUNK));
    const params={path:stage,encoding:'base64',content:chunk.toString('base64'),
      mode:'write_at',offset_bytes:off,expected_chunk_sha256:sha(chunk)};
    const first=await cmd('files.write',params,policy);
    assert.equal(first.bytesWritten,chunk.length);
    assert.equal(first.replayed,false);
    const repeat=await cmd('files.write',params,policy);
    assert.equal(repeat.replayed,true);
    assert.equal(repeat.resumedBytes,chunk.length);
    if(chunk.length) await assert.rejects(()=>
      cmd('files.write',{...params,content:Buffer.alloc(chunk.length,7).toString('base64'),
        expected_chunk_sha256:sha(Buffer.alloc(chunk.length,7))},policy),
      (e:unknown)=>normalizeAgentError(e).code==='FILE_CONFLICT');
  }
  const expected=sha(original);
  const hashed=await cmd('files.hash',{path:stage,max_bytes:size},policy);
  assert.equal(hashed.sha256,expected);
  // A failed expected-hash/size commit leaves source intact and destination absent.
  await assert.rejects(()=>cmd('files.move',{
    source:stage,destination:dst,atomic_no_overwrite:true,
    expected_sha256:'0'.repeat(64),expected_size_bytes:size,
  },policy),(e:unknown)=>normalizeAgentError(e).code==='FILE_CONFLICT');
  await assert.rejects(()=>fs.stat(dst));
  await cmd('files.move',{source:stage,destination:dst,
    atomic_no_overwrite:true,expected_sha256:expected,expected_size_bytes:size},policy);
  await assert.rejects(()=>fs.stat(stage));
  const gathered=Buffer.alloc(size);
  for(let off=0;off<size;off+=CHUNK) {
    const data=await cmd('files.read',{path:dst,encoding:'base64',
      offset_bytes:off,max_bytes:CHUNK,include_sha256:true},policy);
    const bytes=Buffer.from(data.content as string,'base64');
    assert.equal(data.bytesRead,bytes.length);
    assert.equal(data.sha256,sha(bytes));
    bytes.copy(gathered,off);
  }
  assert.deepEqual(gathered,original);
}

test('220 KiB uploads and downloads via bounded chunks with SHA and atomic publish',async t=>{
  await uploadBytes(t,220*1024);
});

test('1 MiB non-sparse uploads and downloads, idempotent replay, conflict denial',async t=>{
  await uploadBytes(t,MiB);
});

test('64-bit-safe offset guards and per-request 64 KiB budgets',async t=>{
  const {dir,policy}=await temporary(t);
  const stage=path.join(dir,'stage.bin');
  await fs.writeFile(stage,'ABC');
  const defaultRange=await cmd('files.read',{path:stage,
    offset_bytes:0,encoding:'base64'},policy);
  assert.equal(defaultRange.bytesRead,3);
  assert.equal(Buffer.from(defaultRange.content as string,'base64').toString(),'ABC');
  await assert.rejects(()=>cmd('files.read',{path:stage,
    offset_bytes:Number.MAX_SAFE_INTEGER,max_bytes:CHUNK},policy),
    /offset exceeds file size/);
  await assert.rejects(()=>cmd('files.read',{path:stage,
    offset_bytes:0,max_bytes:CHUNK+1},policy),/65536/);
  await assert.rejects(()=>cmd('files.write',{path:stage,mode:'write_at',
    offset_bytes:3,encoding:'base64',content:Buffer.alloc(CHUNK+1).toString('base64')},policy),
    /65536/);
  await assert.rejects(()=>cmd('files.write',{path:stage,mode:'write_at',
    offset_bytes:3,encoding:'base64',content:'@@@'},policy),
    (e:unknown)=>normalizeAgentError(e).code==='FILE_CONFLICT');
  await assert.rejects(()=>cmd('files.write',{path:stage,mode:'write_at',
    offset_bytes:Number.MAX_SAFE_INTEGER,content:'X'},policy),/safe integer precision/);
  await assert.rejects(()=>cmd('files.write',{path:stage,mode:'write_at',
    offset_bytes:100,content:'X'},policy),/creates a gap/);
  assert.equal(await fs.readFile(stage,'utf8'),'ABC');
});

test('ENOSPC midway through a chunk is recoverable without publishing a partial final',async t=>{
  const {dir,policy}=await temporary(t);
  const stage=path.join(dir,'stage.tmp');
  const final=path.join(dir,'final.bin');
  await fs.writeFile(stage,'');
  const payload=Buffer.alloc(CHUNK,123);
  const originalOpen=fs.open;
  let failed=false;
  // Scoped failure injection: only our dedicated temporary stage file.
  (fs as unknown as {open:typeof fs.open}).open = (async (...args:Parameters<typeof fs.open>)=>{
    const real=await originalOpen(...args);
    if(String(args[0])!==stage || failed) return real;
    return new Proxy(real,{
      get(target,prop,receiver) {
        if(prop==='write')return async (...parts:unknown[])=>{
          failed=true;
          await target.write(parts[0] as Buffer,Number(parts[1]),
            4096,Number(parts[3]));
          throw Object.assign(new Error('simulated disk full'),{code:'ENOSPC'});
        };
        const v=Reflect.get(target,prop,target);
        return typeof v==='function'?v.bind(target):v;
      },
    });
  }) as typeof fs.open;
  const params={path:stage,mode:'write_at',offset_bytes:0,
    encoding:'base64',content:payload.toString('base64'),
    expected_chunk_sha256:sha(payload)};
  try {
    await assert.rejects(()=>cmd('files.write',params,policy),
      (e:unknown)=>normalizeAgentError(e).code==='ENOSPC');
  } finally {
    (fs as unknown as {open:typeof fs.open}).open=originalOpen;
  }
  assert.equal((await fs.stat(stage)).size,4096);
  await assert.rejects(()=>fs.stat(final));
  const resumed=await cmd('files.write',params,policy);
  assert.equal(resumed.resumedBytes,4096);
  assert.equal(resumed.replayed,false);
  const digest=sha(payload);
  await cmd('files.move',{source:stage,destination:final,
    atomic_no_overwrite:true,expected_sha256:digest,
    expected_size_bytes:payload.length},policy);
  assert.deepEqual(await fs.readFile(final),payload);
});

test('Agent ranged/full read and SHA deny a pathname swap before opening the OS handle', async t => {
  for (const capability of ['range', 'full', 'hash'] as const) {
    const { dir, policy } = await temporary(t);
    const source=path.join(dir,'approved.bin');
    const outsider=path.join(dir,'unapproved-content.bin');
    await fs.writeFile(source,Buffer.from('authorized content'));
    await fs.writeFile(outsider,Buffer.from('sensitive replacement'));
    const realOpen=fs.open;
    let swapped=false;
    (fs as unknown as {open:typeof fs.open}).open=async (...args:Parameters<typeof fs.open>)=>{
      if(String(args[0])===source && !swapped){
        swapped=true;
        await fs.rename(source,source+'.old');
        await fs.copyFile(outsider,source);
      }
      return realOpen(...args);
    };
    try {
      await assert.rejects(
        () => capability==='hash'
          ? cmd('files.hash',{path:source,max_bytes:65536},policy)
          : cmd('files.read',{
              path:source,encoding:'base64',max_bytes:65536,
              ...(capability==='range'?{offset_bytes:0}:{}),
            },policy),
        (e:unknown) => normalizeAgentError(e).code==='FILE_CONFLICT',
      );
    } finally {
      (fs as unknown as {open:typeof fs.open}).open=realOpen;
    }
    assert.equal(swapped,true);
    assert.equal((await fs.readFile(source+'.old','utf8')),'authorized content');
    assert.equal((await fs.readFile(source,'utf8')),'sensitive replacement');
  }
});

test('streaming hash rejects concurrent on-handle mutation rather than returning stale SHA',async t=>{
  const {dir,policy}=await temporary(t);
  const source=path.join(dir,'streaming.bin');
  await fs.writeFile(source,Buffer.alloc(4*MiB,0x11));
  const originalOpen=fs.open;
  let mutated=false;
  (fs as unknown as {open:typeof fs.open}).open=async (...args:Parameters<typeof fs.open>)=>{
    const handle=await originalOpen(...args);
    if(String(args[0])!==source||mutated)return handle;
    let callCount=0;
    return new Proxy(handle,{
      get(target,property){
        if(property==='stat'){
          return async ()=>{
            callCount++;
            if(callCount===2){
              mutated=true;
              const writer=await originalOpen(source,'r+');
              try{await writer.write(Buffer.from([0xFF]),0,1,MiB);await writer.sync();}
              finally{await writer.close();}
            }
            return target.stat();
          };
        }
        const value=Reflect.get(target,property,target);
        return typeof value==='function'?value.bind(target):value;
      },
    });
  };
  try {
    // Strict FAIL-CLOSED when the file's metadata changes during hash.
    await assert.rejects(()=>cmd('files.hash',{
      path:source,max_bytes:4*MiB,
    },policy),(e:unknown)=>normalizeAgentError(e).code==='FILE_CONFLICT');
  } finally {
    (fs as unknown as {open:typeof fs.open}).open=originalOpen;
  }
  assert.equal(mutated,true);
});

test('short positioned writes are retried to full chunk and then verified',async t=>{
  const {dir,policy}=await temporary(t);
  const stage=path.join(dir,'short-write.stage');
  await fs.writeFile(stage,'');
  const chunk=Buffer.alloc(CHUNK,0x5c);
  const nativeOpen=fs.open;
  let shortResponses=0;
  (fs as unknown as {open:typeof fs.open}).open=async (...args:Parameters<typeof fs.open>)=>{
    const handle=await nativeOpen(...args);
    if(String(args[0])!==stage || args[1]!=='r+')return handle;
    return new Proxy(handle,{
      get(target,property){
        if(property==='write')return async (
          bytes:Buffer,bufferOffset:number,length:number,position:number,
        )=>{
          if(shortResponses<3){
            shortResponses++;
            return target.write(bytes,bufferOffset,Math.min(length,73),position);
          }
          return target.write(bytes,bufferOffset,length,position);
        };
        const result=Reflect.get(target,property,target);
        return typeof result==='function'?result.bind(target):result;
      },
    });
  };
  try{
    const data=await cmd('files.write',{path:stage,mode:'write_at',
      offset_bytes:0,content:chunk.toString('base64'),encoding:'base64',
      expected_chunk_sha256:sha(chunk)},policy);
    assert.equal(data.bytesWritten,CHUNK);
  } finally {(fs as unknown as {open:typeof fs.open}).open=nativeOpen;}
  assert.equal(shortResponses,3);
  assert.deepEqual(await fs.readFile(stage),chunk);
  const full=await cmd('files.hash',{path:stage,max_bytes:CHUNK},policy);
  assert.equal(full.sha256,sha(chunk));
});

test('cancelled positioned write reports abort, retains stage only and resumes without unverified publish',async t=>{
  const {dir,policy}=await temporary(t);
  const stage=path.join(dir,'cancel.stage');
  const final=path.join(dir,'final.bin');
  await fs.writeFile(stage,'');
  const chunk=Buffer.alloc(CHUNK,0x3a);
  const nativeOpen=fs.open;
  let aborted=false;
  (fs as unknown as {open:typeof fs.open}).open=async (...args:Parameters<typeof fs.open>)=>{
    const handle=await nativeOpen(...args);
    if(String(args[0])!==stage || args[1]!=='r+' || aborted)return handle;
    return new Proxy(handle,{
      get(target,property){
        if(property==='write')return async (
          bytes:Buffer,bufferOffset:number,_length:number,position:number,
        )=>{
          aborted=true;
          await target.write(bytes,bufferOffset,4096,position);
          throw Object.assign(new Error('synthetic operator cancel'),{
            name:'AbortError',code:'ABORT_ERR',
          });
        };
        const result=Reflect.get(target,property,target);
        return typeof result==='function'?result.bind(target):result;
      },
    });
  };
  const request={path:stage,mode:'write_at',offset_bytes:0,
    content:chunk.toString('base64'),encoding:'base64',
    expected_chunk_sha256:sha(chunk)};
  try{
    await assert.rejects(()=>cmd('files.write',request,policy),
      (error:unknown)=>normalizeAgentError(error).code==='ABORT_ERR');
  } finally {(fs as unknown as {open:typeof fs.open}).open=nativeOpen;}
  assert.equal(aborted,true);
  assert.equal((await fs.stat(stage)).size,4096);
  await assert.rejects(()=>fs.stat(final));
  await assert.rejects(()=>cmd('files.move',{
    source:stage,destination:final,atomic_no_overwrite:true,
    expected_sha256:sha(chunk),expected_size_bytes:CHUNK,
  },policy),(error:unknown)=>normalizeAgentError(error).code==='FILE_CONFLICT');
  const done=await cmd('files.write',request,policy);
  assert.equal(done.resumedBytes,4096);
  await cmd('files.move',{source:stage,destination:final,atomic_no_overwrite:true,
    expected_sha256:sha(chunk),expected_size_bytes:CHUNK},policy);
  assert.deepEqual(await fs.readFile(final),chunk);
});

test('NTFS-like hardlink cannot alias an out-of-scope file through read/hash/write_at/publish',async t=>{
  const {dir,policy}=await temporary(t);
  const original=path.join(dir,'original.bin');
  const alias=path.join(dir,'alias.bin');
  const final=path.join(dir,'published.bin');
  await fs.writeFile(original,Buffer.from('SENSITIVE-HARDLINK-CONTENT'));
  await fs.link(original,alias);
  assert.equal((await fs.stat(alias)).nlink,2);
  const deniesHardlink=(error:unknown)=>normalizeAgentError(error).code==='PATH_DENIED';
  await assert.rejects(()=>cmd('files.read',{
    path:alias,encoding:'base64',offset_bytes:0,max_bytes:64,
  },policy),deniesHardlink);
  await assert.rejects(()=>cmd('files.read',{
    path:alias,encoding:'base64',max_bytes:64,
  },policy),deniesHardlink);
  await assert.rejects(()=>cmd('files.hash',{
    path:alias,max_bytes:1024,
  },policy),deniesHardlink);
  await assert.rejects(()=>cmd('files.write',{
    path:alias,mode:'write_at',offset_bytes:0,content:'S',
  },policy),deniesHardlink);
  await assert.rejects(()=>cmd('files.move',{
    source:alias,destination:final,atomic_no_overwrite:true,
  },policy),deniesHardlink);
  await assert.rejects(()=>cmd('files.write',{
    path:alias,mode:'overwrite',content:'PWN',
  },policy),deniesHardlink);
  await assert.rejects(()=>cmd('files.write',{
    path:alias,mode:'append',content:'PWN',
  },policy),deniesHardlink);
  await assert.rejects(()=>cmd('files.patch',{
    path:alias,max_bytes:1024,
    operations:[{old_text:'SENSITIVE',new_text:'PWN',expected_count:1}],
  },policy),deniesHardlink);
  await assert.rejects(()=>cmd('files.copy',{
    source:alias,destination:final,overwrite:false,
  },policy),deniesHardlink);
  const batch=await cmd('files.read_many',{
    paths:[alias],max_bytes_each:1024,max_total_bytes:4096,
  },policy);
  const first=(batch.results as Array<{ok:boolean;error?:string}>)[0];
  assert.equal(first?.ok,false);
  assert.match(String(first?.error),/HARDLINK_ALIAS_DENIED/);
  assert.equal(await fs.readFile(original,'utf8'),'SENSITIVE-HARDLINK-CONTENT');
  await assert.rejects(()=>fs.stat(final));
});

test('write-only permission cannot use resumable chunks to read existing secret bytes',async t=>{
  const {dir}=await temporary(t);
  const file=path.join(dir,'secret.stage');
  await fs.writeFile(file,'SECRET');
  const writeOnly=new PathPolicy([dir],{defaultScopes:['write']});
  await assert.rejects(()=>cmd('files.write',{
    path:file,mode:'write_at',offset_bytes:0,content:'S',
  },writeOnly),(error:unknown)=>normalizeAgentError(error).code==='PATH_DENIED');
  assert.equal(await fs.readFile(file,'utf8'),'SECRET');
});

test('overlapping concurrent Agent chunks serialize and reject conflicting second writer',async t=>{
  const {dir,policy}=await temporary(t);
  const file=path.join(dir,'concurrent.stage');
  await fs.writeFile(file,'');
  const x=Buffer.alloc(CHUNK,65);
  const y=Buffer.alloc(CHUNK,66);
  const responses=await Promise.allSettled([
    cmd('files.write',{path:file,mode:'write_at',offset_bytes:0,
      encoding:'base64',content:x.toString('base64'),expected_chunk_sha256:sha(x)},policy),
    cmd('files.write',{path:file,mode:'write_at',offset_bytes:0,
      encoding:'base64',content:y.toString('base64'),expected_chunk_sha256:sha(y)},policy),
  ]);
  assert.equal(responses.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(responses.filter(r=>r.status==='rejected' &&
    normalizeAgentError(r.reason).code==='FILE_CONFLICT').length,1);
  const result=await fs.readFile(file);
  assert.equal(result.length,CHUNK);
  assert.ok(result.equals(x)||result.equals(y));
});

test('>256 MiB offset and streaming SHA on a logically sparse temporary file', {timeout:180000}, async t=>{
  const {dir,policy}=await temporary(t);
  const file=path.join(dir,'sparse-320MiB.bin');
  const size=320*MiB;
  const fd=await fs.open(file,'wx');
  try{await fd.truncate(size);}finally{await fd.close();}
  const read=await cmd('files.read',{path:file,offset_bytes:size-CHUNK,
    max_bytes:CHUNK,encoding:'base64'},policy);
  assert.equal(read.bytesRead,CHUNK);
  assert.ok(Buffer.from(read.content as string,'base64').every(x=>x===0));
  const expected=createHash('sha256');
  const zeros=Buffer.alloc(MiB);
  for(let i=0;i<320;i++)expected.update(zeros);
  const hashed=await cmd('files.hash',{path:file,max_bytes:size},policy);
  assert.equal(hashed.sha256,expected.digest('hex'));
  const marker=Buffer.from('verified-high-offset-tail');
  const append=await cmd('files.write',{
    path:file,mode:'write_at',offset_bytes:size,encoding:'base64',
    content:marker.toString('base64'),expected_chunk_sha256:sha(marker),
  },policy);
  assert.equal(append.bytesWritten,marker.length);
  const tail=await cmd('files.read',{
    path:file,offset_bytes:size,encoding:'base64',max_bytes:CHUNK,
  },policy);
  assert.deepEqual(Buffer.from(tail.content as string,'base64'),marker);
  const expectedAfter=createHash('sha256');
  for(let i=0;i<320;i++)expectedAfter.update(zeros);
  expectedAfter.update(marker);
  const finalHash=await cmd('files.hash',{
    path:file,max_bytes:size+marker.length,
  },policy);
  assert.equal(finalHash.sha256,expectedAfter.digest('hex'));
});

test('1 GiB non-sparse temporary file supports ranged reads, high-offset write, SHA256 streaming and atomic publish',
  {timeout:240000, skip: process.env.NEXOWIRE_RUN_LARGE_DISK_FIXTURE === '1'
    ? false : 'physical 1 GiB disk fixture requires explicit opt-in'},async t=>{
    const {dir,policy}=await temporary(t);
    const source=path.join(dir,'non-sparse-1GiB.stage');
    const final=path.join(dir,'non-sparse-1GiB.final');
    const size=1024*MiB;
    const fd=await fs.open(source,'wx');
    const chunk=Buffer.alloc(MiB);
    const expected=createHash('sha256');
    try {
      for(let i=0;i<1024;i++){
        chunk.fill(i%251);
        expected.update(chunk);
        let written=0;
        while(written<chunk.length){
          const result=await fd.write(chunk,written,chunk.length-written,i*MiB+written);
          assert.ok(result.bytesWritten>0);
          written+=result.bytesWritten;
        }
      }
      await fd.sync();
    } finally { await fd.close(); }
    const fileHash=expected.digest('hex');
    const before=await cmd('files.hash',{path:source,max_bytes:size},policy);
    assert.equal(before.sha256,fileHash);
    for(const offset of [0,220*1024,256*MiB+CHUNK,1024*MiB-CHUNK]){
      const read=await cmd('files.read',{path:source,offset_bytes:offset,max_bytes:CHUNK,
        encoding:'base64',include_sha256:true},policy);
      assert.equal(read.bytesRead,CHUNK);
      const b=Buffer.from(read.content as string,'base64');
      assert.equal(sha(b),read.sha256);
      assert.equal(b[0],Math.floor(offset/MiB)%251);
    }
    const append=Buffer.from('nexowire-1GiB-end');
    const after=await cmd('files.write',{path:source,mode:'write_at',
      offset_bytes:size,encoding:'base64',content:append.toString('base64'),
      expected_chunk_sha256:sha(append)},policy);
    assert.equal(after.bytesWritten,append.length);
    const finalHash=createHash('sha256');
    // Rehash in 1 MiB chunks. Keep RAM bounded.
    for(let i=0;i<1024;i++){chunk.fill(i%251);finalHash.update(chunk);}
    finalHash.update(append);
    const expectedFinal=finalHash.digest('hex');
    const actual=await cmd('files.hash',{path:source,max_bytes:size+append.length},policy);
    assert.equal(actual.sha256,expectedFinal);
    await cmd('files.move',{source,destination:final,atomic_no_overwrite:true,
      expected_sha256:expectedFinal,expected_size_bytes:size+append.length},policy);
    assert.equal((await fs.stat(final)).size,size+append.length);
    const tail=await cmd('files.read',{path:final,offset_bytes:size,max_bytes:CHUNK,
      encoding:'base64'},policy);
    assert.deepEqual(Buffer.from(tail.content as string,'base64'),append);
  });
