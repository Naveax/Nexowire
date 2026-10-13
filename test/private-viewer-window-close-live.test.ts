import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';
import {handleLocalPrivateWindowClose} from '../src/agent/windows-private-viewer.js';

test('confirmed Viewer local close request gracefully closes a tracked private window only',{
  skip:process.platform!=='win32',timeout:60_000,
},async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nx-viewer-local-close-'));
  const previous={
    desktop:process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR,
    viewer:process.env.NEXOWIRE_PRIVATE_VIEWER_DIR,
    skip:process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT,
  };
  const deskDir=path.join(dir,'desktop');
  const viewerDir=path.join(dir,'viewer');
  await fs.mkdir(deskDir,{recursive:true});
  await fs.mkdir(viewerDir,{recursive:true});
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=deskDir;
  process.env.NEXOWIRE_PRIVATE_VIEWER_DIR=viewerDir;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await desktop('windows.private_desktop.stop',{}).catch(()=>undefined);
    for(const [key,value] of Object.entries({
      NEXOWIRE_PRIVATE_DESKTOP_DIR:previous.desktop,
      NEXOWIRE_PRIVATE_VIEWER_DIR:previous.viewer,
      NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT:previous.skip,
    })){
      if(value===undefined)delete process.env[key];
      else process.env[key]=value;
    }
    await fs.rm(dir,{force:true,recursive:true,maxRetries:10,retryDelay:150});
  });

  const request=path.join(viewerDir,'window-close.request.json');
  const result=path.join(viewerDir,'window-close.result.json');

  await fs.writeFile(request,'{"action":"kill_process","hwnd":"0x1"}');
  await handleLocalPrivateWindowClose();
  const invalid=JSON.parse(await fs.readFile(result,'utf8'));
  assert.equal(invalid.ok,false);
  assert.match(invalid.message,/Not closed/);
  await assert.rejects(fs.stat(request),{code:'ENOENT'});

  await desktop('windows.private_desktop.start',{create_shortcut:false});
  const first=await desktop('windows.private_desktop.windows',{}) as {
    data:{windows:Array<{title:string;hwnd:string}>;inputDesktop:string};
  };
  assert.equal(first.data.inputDesktop,'Default');
  const shell=first.data.windows.find(w=>w.title==='Nexowire Private Desktop');
  assert.ok(shell);
  await fs.writeFile(request,JSON.stringify({action:'close_private_window',hwnd:shell.hwnd}));
  await handleLocalPrivateWindowClose();
  const blocked=JSON.parse(await fs.readFile(result,'utf8'));
  assert.equal(blocked.ok,false);
  assert.match(blocked.message,/Not closed/);

  const fixture=path.join(dir,'fixture.ps1');
  await fs.writeFile(fixture,[
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName PresentationFramework',
    'Add-Type -AssemblyName PresentationCore',
    'Add-Type -AssemblyName WindowsBase',
    '$window=New-Object Windows.Window',
    "$window.Title='Nexowire Viewer Managed Close'",
    '$window.Width=540','$window.Height=340',
    '[void]$window.ShowDialog()',
  ].join('\n'),'utf8');
  await desktop('windows.private_desktop.launch',{
    executable:'powershell.exe',
    args:['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-STA','-File',fixture],
  });
  let hwnd:string|undefined;
  for(let i=0;i<35;i++){
    const snapshot=await desktop('windows.private_desktop.windows',{}) as {
      data:{windows:Array<{hwnd:string;title:string}>;inputDesktop:string};
    };
    assert.equal(snapshot.data.inputDesktop,'Default');
    hwnd=snapshot.data.windows.find(w=>w.title==='Nexowire Viewer Managed Close')?.hwnd;
    if(hwnd)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(hwnd);
  await fs.writeFile(request,JSON.stringify({action:'close_private_window',hwnd}));
  await handleLocalPrivateWindowClose();
  const closed=JSON.parse(await fs.readFile(result,'utf8'));
  assert.equal(closed.ok,true);
  assert.match(closed.message,/Managed private window closed/);
  assert.ok(Number.isFinite(Date.parse(closed.at)));
  const after=await desktop('windows.private_desktop.windows',{}) as {
    data:{windows:Array<{hwnd:string;title:string}>;inputDesktop:string};
  };
  assert.equal(after.data.inputDesktop,'Default');
  assert.ok(!after.data.windows.some(w=>w.hwnd===hwnd));
  assert.ok(after.data.windows.some(w=>w.title==='Nexowire Private Desktop'));
});
