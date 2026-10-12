import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {BrowserManager} from '../src/agent/browser-manager.js';
import {executeWindowsPrivateDesktopCapability} from '../src/agent/windows-private-desktop.js';

test('visible Windows browser never silently opens on the user desktop',{
  skip:process.platform!=='win32',
},async()=>{
  const manager=new BrowserManager();
  await assert.rejects(
    manager.start({headless:false}),
    (error:unknown)=>error instanceof Error &&
      'code' in error&&error.code==='BROWSER_VISIBLE_DEFAULT_DENIED',
  );
});

test('private GUI browser is CDP-controlled on NexowirePrivate without a Default desktop switch',{
  skip:process.platform!=='win32'||process.env.NEXOWIRE_RUN_PRIVATE_BROWSER_LIVE!=='1',
  timeout:90_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-private-browser-live-'));
  const oldRoot=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const oldSkip=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=path.join(root,'desktop');
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  const browser=new BrowserManager({rootDir:path.join(root,'profiles')});
  t.after(async()=>{
    await browser.stopAll().catch(()=>undefined);
    await executeWindowsPrivateDesktopCapability('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(oldRoot===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=oldRoot;
    if(oldSkip===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=oldSkip;
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:150}).catch(()=>undefined);
  });

  const started=await browser.start({
    browser:'edge',headless:false,uiTarget:'private_desktop',
    initialUrl:'about:blank',width:1100,height:760,
  });
  assert.equal(started.uiTarget,'private_desktop');
  assert.equal(started.desktopName,'NexowirePrivate');
  assert.equal(started.headless,false);
  const listed=browser.list().find(session=>session.id===started.id);
  assert.equal(listed?.status,'running');
  const tabs=await browser.tabs(started.id);
  assert.ok(tabs.tabs.some(tab=>tab.url==='about:blank'));
  const privateStatus=await executeWindowsPrivateDesktopCapability(
    'windows.private_desktop.status',{},
  ) as {data:{running:boolean;inputDesktop:string}};
  assert.equal(privateStatus.data.running,true);
  assert.equal(privateStatus.data.inputDesktop,'Default');
  const stopped=await browser.stop(started.id);
  assert.equal(stopped.stopped,true);
});
