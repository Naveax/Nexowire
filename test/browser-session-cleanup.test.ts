import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BrowserManager} from '../src/agent/browser-manager.js';
import {isVerifiedOwnedBrowserProcess,removeOwnedBrowserProfile,
  verifyOwnedBrowserProfile} from '../src/agent/browser-session-cleanup.js';

const uuid='11111111-1111-4111-8111-111111111111';
const failure=(code:string)=>(error:unknown)=>
  !!error&&typeof error==='object'&&'code'in error&&error.code===code;
const locked=()=>Object.assign(new Error('synthetic Windows lockfile busy'),{code:'EBUSY'});

test('browser shutdown retry waits for owned profile lock release, not another session',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-browser-cleanup-'));
  const profile=path.join(root,uuid);
  const other=path.join(root,'22222222-2222-4222-8222-222222222222');
  try{
    await fs.mkdir(profile);await fs.mkdir(other);
    await fs.writeFile(path.join(profile,'lockfile'),'owned only');
    await fs.writeFile(path.join(other,'lockfile'),'foreign session');
    let attempts=0;
    const pauses:number[]=[];
    await removeOwnedBrowserProfile(root,profile,{
      maxAttempts:5,retryDelayMs:2,pause:async ms=>{pauses.push(ms);},
      remove:async target=>{
        attempts++;
        if(attempts<3)throw locked();
        await fs.rm(target,{recursive:true,force:false});
      },
    });
    assert.equal(attempts,3);
    assert.deepEqual(pauses,[2,2]);
    await assert.rejects(fs.access(profile),error=>
      !!error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT');
    assert.equal(await fs.readFile(path.join(other,'lockfile'),'utf8'),
      'foreign session');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('permanent EBUSY cannot be hidden as successful profile shutdown',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-browser-ebusy-'));
  const profile=path.join(root,uuid);
  try{
    await fs.mkdir(profile);
    let attempts=0;
    await assert.rejects(removeOwnedBrowserProfile(root,profile,{
      maxAttempts:3,retryDelayMs:0,pause:async()=>undefined,
      remove:async()=>{attempts++;throw locked();},
    }),failure('BROWSER_PROFILE_CLEANUP_FAILED'));
    assert.equal(attempts,3);
    await fs.access(profile);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('browser cleanup denies traversal, foreign paths and reparse profile',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-browser-scope-'));
  const external=await fs.mkdtemp(path.join(os.tmpdir(),'nx-browser-outside-'));
  try{
    await fs.mkdir(path.join(root,'not-a-uuid'));
    await assert.rejects(verifyOwnedBrowserProfile(root,external),
      failure('BROWSER_PROFILE_OWNERSHIP_INVALID'));
    await assert.rejects(verifyOwnedBrowserProfile(root,path.join(root,'not-a-uuid')),
      failure('BROWSER_PROFILE_OWNERSHIP_INVALID'));
    const link=path.join(root,uuid);
    try{
      await fs.symlink(external,link,process.platform==='win32'?'junction':'dir');
      await assert.rejects(removeOwnedBrowserProfile(root,link),
        failure('BROWSER_PROFILE_OWNERSHIP_INVALID'));
      await fs.access(external);
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=='EPERM'&&
         (error as NodeJS.ErrnoException).code!=='EACCES')throw error;
    }
  }finally{
    await fs.rm(root,{recursive:true,force:true});
    await fs.rm(external,{recursive:true,force:true});
  }
});

test('browser kill ownership requires exact PID, executable and unique profile',()=>{
  const executable='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const profile='C:\\Users\\Runner\\AppData\\Local\\Temp\\nexowire-browser-live\\'+uuid;
  const evidence={pid:10042,executablePath:executable,
    commandLine:'"'+executable+'" --remote-debugging-port=0 --user-data-dir="'+profile+'" --headless=new'};
  assert.equal(isVerifiedOwnedBrowserProcess(evidence,10042,executable,profile),true);
  assert.equal(isVerifiedOwnedBrowserProcess({...evidence,pid:999},10042,executable,profile),false);
  assert.equal(isVerifiedOwnedBrowserProcess({...evidence,executablePath:'C:\\Windows\\System32\\calc.exe'},10042,executable,profile),false);
  assert.equal(isVerifiedOwnedBrowserProcess({...evidence,commandLine:'"'+executable+'" --headless'},10042,executable,profile),false);
  assert.equal(isVerifiedOwnedBrowserProcess(evidence,10042,executable,
    'C:\\Users\\Runner\\other-profile'),false);
  assert.equal(isVerifiedOwnedBrowserProcess(null,10042,executable,profile),false);
});

test('stopAll propagates a failed owned-process cleanup, never allSettled success',async()=>{
  const manager=new BrowserManager();
  const instance=manager as unknown as {
    sessions:Map<string,unknown>;stop:(id:string)=>Promise<unknown>;
  };
  instance.sessions.set(uuid,{});
  let invoked=0;
  instance.stop=async()=>{invoked++;throw Object.assign(
    new Error('locked browser profile'),{code:'BROWSER_PROFILE_CLEANUP_FAILED'});};
  await assert.rejects(manager.stopAll(),failure('BROWSER_PROFILE_CLEANUP_FAILED'));
  assert.equal(invoked,1);
});
