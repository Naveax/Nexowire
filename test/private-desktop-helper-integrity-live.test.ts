import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';

test('native private UIA generated helper refuses post-start file tampering',{
  skip:process.platform!=='win32',timeout:80_000,
},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-helper-integrity-'));
  const prevRoot=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const prevShortcut=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=root;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await desktop('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(prevRoot===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=prevRoot;
    if(prevShortcut===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=prevShortcut;
    await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:150});
  });
  const start=await desktop('windows.private_desktop.start',{create_shortcut:false}) as {
    data:{inputDesktop:string};
  };
  assert.equal(start.data.inputDesktop,'Default');
  const helper=path.join(root,'input-helper.ps1');
  const contents=await fs.readFile(helper,'utf8');
  // Appending a comment still leaves a syntactically valid helper script.
  // An integrity check must reject ANY unauthorized byte-level replacement,
  // not just scripts naming obvious WSL, Explorer or shell brokers.
  await fs.writeFile(helper,contents+'\n# SYNTHETIC_UNTRUSTED_HELPER_MODIFICATION\n','utf8');
  await assert.rejects(
    desktop('windows.private_desktop.accessibility',{hwnd:'0x1'}),
    (error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&
      error.code==='PRIVATE_DESKTOP_INTERNAL_HELPER_INTEGRITY',
  );
  // The control helper is a separate generated script and must carry
  // the identical fail-closed guarantee before list/launch requests.
  await fs.writeFile(helper,contents,'utf8');
  const controlHelper=path.join(root,'helper.ps1');
  const controlContents=await fs.readFile(controlHelper,'utf8');
  await fs.appendFile(controlHelper,'\n# SYNTHETIC_CONTROL_HELPER_MODIFICATION\n','utf8');
  await assert.rejects(
    desktop('windows.private_desktop.windows',{}),
    (error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&
      error.code==='PRIVATE_DESKTOP_INTERNAL_HELPER_INTEGRITY',
  );
  await assert.rejects(
    desktop('windows.private_desktop.status',{}),
    (error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&
      error.code==='PRIVATE_DESKTOP_INTERNAL_HELPER_INTEGRITY',
  );
  await fs.writeFile(controlHelper,controlContents,'utf8');
  const after=await desktop('windows.private_desktop.status',{}) as {
    data:{inputDesktop:string};
  };
  assert.equal(after.data.inputDesktop,'Default');
});
