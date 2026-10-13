import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeWindowsPrivateDesktopCapability as desktop } from '../src/agent/windows-private-desktop.js';
import { captureWindowsPrivateScreen as capture } from '../src/agent/windows-private-screen.js';
import { recoverUnavailablePrivatePreview } from '../src/agent/windows-private-viewer.js';

test('real closed NexowirePrivate window recovers to all monitors without showing Default',{
  skip:process.platform!=='win32',timeout:60_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-viewer-closed-live-'));
  const oldRoot=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const oldSkip=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=root;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await desktop('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(oldRoot===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=oldRoot;
    if(oldSkip===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=oldSkip;
    await fs.rm(root,{force:true,recursive:true,maxRetries:10,retryDelay:150});
  });
  const fixture=path.join(root,'closed-window-fixture.ps1');
  await fs.writeFile(fixture,[
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName PresentationFramework',
    'Add-Type -AssemblyName PresentationCore',
    'Add-Type -AssemblyName WindowsBase',
    '$w=New-Object Windows.Window',
    "$w.Title='Nexowire Closed Window Recovery Fixture'",
    '$w.Width=560','$w.Height=380',
    "$w.WindowStartupLocation='CenterScreen'",
    '$t=New-Object Windows.Controls.TextBlock',
    "$t.Text='PRIVATE WINDOW'",'$w.Content=$t',
    '[void]$w.ShowDialog()',
  ].join('\n'),'utf8');
  const started=await desktop('windows.private_desktop.start',{create_shortcut:false});
  assert.equal((started as {data:{inputDesktop:string}}).data.inputDesktop,'Default');
  const spawned=await desktop('windows.private_desktop.launch',{
    executable:'powershell.exe',args:[
      '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-STA','-File',fixture,
    ],
  });
  const pid=(spawned as {data:{pid:number}}).data.pid;
  assert.ok(pid>0);
  let hwnd:string|undefined;
  for(let i=0;i<35;i++){
    const info=await desktop('windows.private_desktop.windows',{}) as {
      data:{windows:Array<{title:string;hwnd:string}>;inputDesktop:string};
    };
    assert.equal(info.data.inputDesktop,'Default');
    hwnd=info.data.windows.find(w=>w.title==='Nexowire Closed Window Recovery Fixture')?.hwnd;
    if(hwnd)break;
    await new Promise(r=>setTimeout(r,120));
  }
  assert.ok(hwnd,'Private fixture must expose its HWND');
  const live=await capture({source:'window',hwnd,max_width:1024,max_height:768});
  assert.equal(live.data.source,'window');
  assert.equal(live.data.inputDesktopAfter,'Default');
  assert.equal(live.data.capturedWindows,1);

  process.kill(pid);
  let missing=false;
  for(let i=0;i<30;i++){
    const info=await desktop('windows.private_desktop.windows',{}) as {
      data:{windows:Array<{hwnd:string}>};
    };
    if(!info.data.windows.some(w=>w.hwnd.toUpperCase()===hwnd!.toUpperCase())){
      missing=true;break;
    }
    await new Promise(r=>setTimeout(r,100));
  }
  assert.equal(missing,true,'Fixture window should have closed');
  let closedError:unknown;
  try{await capture({source:'window',hwnd,max_width:1024,max_height:768});}
  catch(error){closedError=error;}
  assert.ok(closedError && typeof closedError==='object');
  assert.equal((closedError as {code:string}).code,'WINDOW_NOT_PRIVATE_DESKTOP');
  const preview={
    version:1 as const,pid:1,startedAt:new Date().toISOString(),
    refreshMs:500,maxWidth:1024,maxHeight:768,maxBytes:4194304,
    topmost:false,selectedMonitorId:null,selectedWindowHwnd:hwnd,
    lastSelectionError:null,emptyCaptureArea:null,lastFrameAt:null,
    frameBytes:null,frameWidth:null,frameHeight:null,lastError:null,
  };
  const restored=recoverUnavailablePrivatePreview(preview,closedError);
  assert.ok(restored);
  assert.equal(restored.selectedWindowHwnd,null);
  const all=await capture({source:'desktop',max_width:1024,max_height:768});
  assert.equal(all.data.source,'desktop');
  assert.equal(all.data.inputDesktopBefore,'Default');
  assert.equal(all.data.inputDesktopAfter,'Default');
  assert.equal(all.data.visibleDesktopChanged,false);
  assert.equal(Buffer.from(all.data.base64,'base64').subarray(0,4).toString('hex'),'89504e47');
});
