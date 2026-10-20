import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';
import {executeWindowsWindowCapability} from '../src/agent/windows-window-control.js';

const integrity=(error:unknown)=>error instanceof Error&&
  'code'in error&&error.code==='PRIVATE_DESKTOP_INTERNAL_HELPER_INTEGRITY';

test('real Windows private helper identical-length replacement and missing file fail closed',{
  skip:process.platform!=='win32',timeout:90_000,
},async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-trust-real-'));
  const savedRoot=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const savedShortcut=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=temp;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await desktop('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(savedRoot===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=savedRoot;
    if(savedShortcut===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=savedShortcut;
    await fs.rm(temp,{recursive:true,force:true,maxRetries:8,retryDelay:125});
  });
  const started=await desktop('windows.private_desktop.start',{create_shortcut:false}) as{
    data:{inputDesktop:string;hostPid:number;shellPid:number};
  };
  assert.equal(started.data.inputDesktop,'Default');
  const physical=await executeWindowsWindowCapability('windows.window.list',{}) as{
    data:{foregroundHwnd:string|null;windows:Array<{processId:number;hwnd:string}>};
  };
  const privateWindows=await desktop('windows.private_desktop.windows',{}) as{
    data:{inputDesktop:string;windows:Array<{processId:number;hwnd:string}>};
  };
  assert.equal(privateWindows.data.inputDesktop,'Default');
  assert.ok(privateWindows.data.windows.some(w=>w.processId===started.data.shellPid),
    'The owned private desktop shell must be enumerated on NexowirePrivate');
  assert.equal(physical.data.windows.some(w=>w.processId===started.data.shellPid),false,
    'Private desktop shell must never surface on owner Default desktop');
  assert.equal(privateWindows.data.windows.some(w=>
    w.hwnd.toLowerCase()===physical.data.foregroundHwnd?.toLowerCase()),false,
    'User foreground HWND must not alias a private window');
  const input=path.join(temp,'input-helper.ps1');
  const original=await fs.readFile(input);
  // Same-size replacement defeats a size-only check but not pinned SHA-256.
  const mutated=Buffer.from(original);
  const changedByte=Math.floor(mutated.length/2);
  mutated[changedByte]=(mutated[changedByte]??0)^1;
  await fs.writeFile(input,mutated);
  assert.equal((await fs.stat(input)).size,original.length);
  await assert.rejects(desktop('windows.private_desktop.accessibility',{hwnd:'0x1'}),
    integrity);
  await fs.writeFile(input,original);
  const control=path.join(temp,'helper.ps1');
  const parked=path.join(temp,'helper.ps1.disconnected');
  await fs.rename(control,parked);
  await assert.rejects(desktop('windows.private_desktop.windows',{}),integrity);
  await assert.rejects(desktop('windows.private_desktop.status',{}),integrity);
  await fs.rename(parked,control);
  const restored=await desktop('windows.private_desktop.status',{}) as{
    data:{running:boolean;inputDesktop:string};
  };
  assert.equal(restored.data.running,true);
  assert.equal(restored.data.inputDesktop,'Default');
});
