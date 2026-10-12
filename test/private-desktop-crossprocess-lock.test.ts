import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  withPrivateDesktopProcessLock,
} from '../src/agent/windows-private-desktop-lock.js';

async function tempRoot():Promise<string>{
  return await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-crossproc-lock-'));
}

test('same-process lifecycle operations remain serialized, including failures',async()=>{
  const root=await tempRoot();
  const order:string[]=[];
  try{
    const first=withPrivateDesktopProcessLock(root,async()=>{
      order.push('first-start');
      await new Promise(resolve=>setTimeout(resolve,140));
      order.push('first-end');
      throw Error('intended');
    });
    await new Promise(resolve=>setTimeout(resolve,15));
    const second=withPrivateDesktopProcessLock(root,async()=>{
      order.push('second-start');
      await new Promise(resolve=>setTimeout(resolve,60));
      order.push('second-end');
      return 42;
    });
    await assert.rejects(first,/intended/);
    assert.equal(await second,42);
    assert.deepEqual(order,[
      'first-start','first-end','second-start','second-end',
    ]);
    await assert.rejects(fs.stat(path.join(root,'.lifecycle.lock')),
      (error:unknown)=>typeof error==='object'&&error!==null&&
        'code' in error&&error.code==='ENOENT');
  }finally{
    await fs.rm(root,{recursive:true,force:true});
  }
});

test('a different live worker PID is never evicted; failure is bounded',async()=>{
  const root=await tempRoot();
  const lock=path.join(root,'.lifecycle.lock');
  try{
    await fs.mkdir(lock);
    await fs.writeFile(path.join(lock,'owner.json'),JSON.stringify({
      version:1,pid:process.pid,nonce:'00000000-0000-4000-a000-000000000000',
      startedAt:Date.now()-300_000,
    }));
    const old=new Date(Date.now()-300_000);
    await fs.utimes(lock,old,old);
    await assert.rejects(withPrivateDesktopProcessLock(root,
      async()=>{throw Error('must not enter');},{timeoutMs:350,staleMs:1000}),
      (error:unknown)=>typeof error==='object'&&error!==null&&
        'code' in error&&error.code==='PRIVATE_DESKTOP_LIFECYCLE_LOCK_BUSY');
    assert.equal((await fs.stat(lock)).isDirectory(),true);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('missing or malformed ownership never permits stale lock reclamation',async()=>{
  for(const variant of ['missing','malformed','invalid-record'] as const){
    const root=await tempRoot();
    const lock=path.join(root,'.lifecycle.lock');
    try{
      await fs.mkdir(lock);
      if(variant==='malformed'){
        await fs.writeFile(path.join(lock,'owner.json'),'{not-json');
      }else if(variant==='invalid-record'){
        await fs.writeFile(path.join(lock,'owner.json'),JSON.stringify({
          version:1,pid:'not-a-pid',nonce:'invalid',startedAt:0,
        }));
      }
      const old=new Date(Date.now()-300_000);
      await fs.utimes(lock,old,old);
      const expected=variant==='missing'
        ?'PRIVATE_DESKTOP_LIFECYCLE_LOCK_BUSY'
        :'PRIVATE_DESKTOP_LOCK_OWNER_INVALID';
      await assert.rejects(withPrivateDesktopProcessLock(root,
        async()=>{throw Error('must not enter');},
        {timeoutMs:350,staleMs:1000}),
        (error:unknown)=>typeof error==='object'&&error!==null&&
          'code' in error&&error.code===expected,variant);
      assert.equal((await fs.stat(lock)).isDirectory(),true,variant);
    }finally{
      await fs.rm(root,{recursive:true,force:true});
    }
  }
});

test('dead worker lock recovers under guarded reclamation',async()=>{
  const root=await tempRoot();
  const lock=path.join(root,'.lifecycle.lock');
  try{
    await fs.mkdir(lock);
    await fs.writeFile(path.join(lock,'owner.json'),JSON.stringify({
      version:1,pid:2147483647,nonce:'00000000-0000-4000-a000-000000000000',
      startedAt:Date.now()-300_000,
    }));
    const old=new Date(Date.now()-300_000);
    await fs.utimes(lock,old,old);
    assert.equal(await withPrivateDesktopProcessLock(root,async()=>123,{staleMs:1000}),123);
    await assert.rejects(fs.stat(lock),
      (error:unknown)=>typeof error==='object'&&error!==null&&
        'code' in error&&error.code==='ENOENT');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('two separate Node processes share one real lifecycle lock',async(t)=>{
  const root=await tempRoot();
  const ready=path.join(root,'ready.flag');
  const moduleUrl=new URL('../src/agent/windows-private-desktop-lock.ts',import.meta.url).href;
  const childCode=[
    'const {withPrivateDesktopProcessLock}=await import(process.argv[1]);',
    "const fs=await import('node:fs/promises');",
    'await withPrivateDesktopProcessLock(process.argv[2],async()=>{',
    "await fs.writeFile(process.argv[3],'ready');",
    'await new Promise(resolve=>setTimeout(resolve,1300));',
    '});',
  ].join('\n');
  const child=spawn(process.execPath,[
    '--import','tsx','--input-type=module','-e',childCode,
    moduleUrl,root,ready,
  ],{cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';
  child.stderr?.on('data',chunk=>{output+=String(chunk).slice(0,3000);});
  const exited=new Promise<number|null>(resolve=>child.once('exit',resolve));
  t.after(async()=>{
    if(child.exitCode===null)child.kill();
    await exited;
    await fs.rm(root,{recursive:true,force:true});
  });
  let observed=false;
  const deadline=Date.now()+8000;
  while(Date.now()<deadline){
    if(await fs.stat(ready).then(()=>true,()=>false)){observed=true;break;}
    if(child.exitCode!==null)break;
    await new Promise(resolve=>setTimeout(resolve,30));
  }
  assert.equal(observed,true,output);
  const started=Date.now();
  const status=await withPrivateDesktopProcessLock(root,async()=>true);
  assert.equal(status,true);
  assert.ok(Date.now()-started>=350,'second process entered locked region prematurely');
  assert.equal(await exited,0,output);
});
