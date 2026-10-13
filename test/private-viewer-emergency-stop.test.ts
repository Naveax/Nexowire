import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  executeWindowsPrivateDesktopCapability,
} from '../src/agent/windows-private-desktop.js';
import {
  executeWindowsPrivateViewerCapability,
} from '../src/agent/windows-private-viewer.js';

test('AI viewer exposes a locally confirmed emergency stop without physical cursor actions',()=>{
  const source=readFileSync(
    new URL('../src/agent/windows-private-viewer.ts',import.meta.url),'utf8',
  );
  assert.match(source,/STOP AI WORKSPACE/);
  assert.match(source,/MessageBoxButton\]::YesNo/);
  assert.match(source,/STOP_NEXOWIREPRIVATE/);
  assert.match(source,/PRIVATE_STOP_INPUT_DESKTOP_NOT_DEFAULT/);
  assert.match(source,/windows\.private_desktop\.stop/);
  assert.match(source,/await viewerStop\(\)/);
});

test('a confirmed viewer stop request shuts down only the isolated desktop and viewer',{
  skip:process.platform!=='win32'||process.env.NEXOWIRE_RUN_VIEWER_EMERGENCY_LIVE!=='1',
  timeout:100_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-emergency-live-'));
  const prior={
    NEXOWIRE_PRIVATE_DESKTOP_DIR:process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR,
    NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT:process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT,
    NEXOWIRE_PRIVATE_VIEWER_DIR:process.env.NEXOWIRE_PRIVATE_VIEWER_DIR,
  };
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=path.join(root,'desktop');
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  process.env.NEXOWIRE_PRIVATE_VIEWER_DIR=path.join(root,'viewer');
  t.after(async()=>{
    await executeWindowsPrivateViewerCapability('windows.private_viewer.stop',{}).catch(()=>undefined);
    await executeWindowsPrivateDesktopCapability('windows.private_desktop.stop',{}).catch(()=>undefined);
    for(const [key,value] of Object.entries(prior)){
      if(value===undefined)delete process.env[key];
      else process.env[key]=value;
    }
    await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})
      .catch(()=>undefined);
  });
  const started=await executeWindowsPrivateDesktopCapability(
    'windows.private_desktop.start',{create_shortcut:false},
  ) as {data:{running:boolean}};
  assert.equal(started.data.running,true);

  const viewer=await executeWindowsPrivateViewerCapability(
    'windows.private_viewer.start',{
      refresh_ms:500,max_width:850,max_height:550,topmost:false,
    },
  ) as {data:{running:boolean}};
  assert.equal(viewer.data.running,true);

  // Simulate the exact local WPF-confirmed IPC string, not a remote
  // physical-input action. This test runs against disposable DEV state.
  await fs.writeFile(path.join(root,'viewer','emergency-stop.request'),
    'STOP_NEXOWIREPRIVATE','utf8');
  let stopped=false;
  const deadline=Date.now()+18_000;
  while(Date.now()<deadline){
    const desktop=await executeWindowsPrivateDesktopCapability(
      'windows.private_desktop.status',{},
    ) as {data:{running:boolean;inputDesktop:string}};
    const view=await executeWindowsPrivateViewerCapability(
      'windows.private_viewer.status',{},
    ) as {data:{running:boolean}};
    assert.equal(desktop.data.inputDesktop,'Default');
    if(!desktop.data.running&&!view.data.running){
      stopped=true;
      break;
    }
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.equal(stopped,true,'emergency request must stop the private desktop and viewer');
  const userDesktop=await executeWindowsPrivateDesktopCapability(
    'windows.private_desktop.status',{},
  ) as {data:{inputDesktop:string}};
  assert.equal(userDesktop.data.inputDesktop,'Default');
});
