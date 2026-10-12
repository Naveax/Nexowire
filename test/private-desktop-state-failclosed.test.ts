import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {promises as fs,readFileSync} from 'node:fs';
import {executeWindowsPrivateDesktopCapability} from '../src/agent/windows-private-desktop.js';

test('private desktop source rejects unknown persisted host state before replacement',()=>{
  const source=readFileSync(new URL('../src/agent/windows-private-desktop.ts',import.meta.url),'utf8');
  assert.match(source,/PRIVATE_DESKTOP_STATE_INVALID/);
  assert.match(source,/PRIVATE_DESKTOP_PARTIAL_HOST/);
  assert.match(source,/\[old\.hostPid,old\.shellPid,\.\.\.old\.launchedPids\]\.some\(alive\)/);
});

test('malformed persisted host state fails closed on Windows without deleting it',{
  skip:process.platform!=='win32'||process.env.NEXOWIRE_RUN_PRIVATE_STATE_LIVE!=='1',
  timeout:60_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-private-state-'));
  const previous=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=root;
  t.after(async()=>{
    if(previous===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=previous;
    await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:70});
  });
  for(const body of ['{broken-json',JSON.stringify({version:1,desktopName:'NexowirePrivate',hostPid:'NaN'})]){
    await fs.writeFile(path.join(root,'state.json'),body);
    for(const capability of ['windows.private_desktop.start','windows.private_desktop.stop','windows.private_desktop.status']){
      await assert.rejects(
        executeWindowsPrivateDesktopCapability(capability,{create_shortcut:false}),
        (error:unknown)=>typeof error==='object'&&error!==null&&'code' in error&&
          error.code==='PRIVATE_DESKTOP_STATE_INVALID',
        capability,
      );
      assert.equal(await fs.readFile(path.join(root,'state.json'),'utf8'),body);
    }
  }
});

test('partially alive desktop host or launched child is not orphaned during restart',{
  skip:process.platform!=='win32'||process.env.NEXOWIRE_RUN_PRIVATE_STATE_LIVE!=='1',
  timeout:60_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-private-partial-'));
  const previous=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=root;
  t.after(async()=>{
    if(previous===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=previous;
    await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:70});
  });
  const deadPid=2147483647;
  for(const [hostPid,shellPid,launchedPids] of [
    [process.pid,deadPid,[]],
    [deadPid,process.pid,[]],
    [deadPid,deadPid,[process.pid]],
  ] as [number,number,number[]][]){
    const state={
      version:1,desktopName:'NexowirePrivate',
      hostPid,shellPid,launchedPids,startedAt:new Date().toISOString(),
    };
    const raw=JSON.stringify(state);
    await fs.writeFile(path.join(root,'state.json'),raw);
    await assert.rejects(
      executeWindowsPrivateDesktopCapability(
        'windows.private_desktop.start',{create_shortcut:false},
      ),
      (error:unknown)=>typeof error==='object'&&error!==null&&
        'code' in error&&error.code==='PRIVATE_DESKTOP_PARTIAL_HOST',
    );
    assert.equal(await fs.readFile(path.join(root,'state.json'),'utf8'),raw);
  }
});
