import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';
import {
  captureWindowsPrivateScreen,
  inspectWindowsPrivateDisplayTopology,
  type WindowsPrivateScreenCapture,
} from '../src/agent/windows-private-screen.js';
import {
  captureWindowsPrivateScreenSet,
} from '../src/agent/windows-private-screen-set.js';

test('repeated all-screen, per-monitor and explicit-window private captures preserve input desktop',{
  skip:process.platform!=='win32' ||
    process.env.NEXOWIRE_RUN_AI_SCREEN_REPEAT_SOAK_LIVE!=='1',
  timeout:170_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-screen-soak-'));
  const prior=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const skip=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=root;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await desktop('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(prior===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=prior;
    if(skip===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=skip;
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });

  const start=await desktop('windows.private_desktop.start',{
    create_shortcut:false,
  }) as {data:{inputDesktop:string;running:boolean}};
  assert.equal(start.data.inputDesktop,'Default');
  assert.equal(start.data.running,true);
  const fixture=path.join(root,'screen-soak-fixture.ps1');
  await fs.writeFile(fixture,[
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName PresentationFramework',
    'Add-Type -AssemblyName PresentationCore',
    'Add-Type -AssemblyName WindowsBase',
    '$window=New-Object Windows.Window',
    "$window.Title='Nexowire Repeated Private Capture'",
    '$window.Width=640',
    '$window.Height=380',
    '$window.ShowInTaskbar=$false',
    '$label=New-Object Windows.Controls.TextBlock',
    "$label.Text='PRIVATE DISPLAY ONLY'",
    '$window.Content=$label',
    '[void]$window.ShowDialog()',
  ].join('\n'),'utf8');
  await desktop('windows.private_desktop.launch',{
    executable:'powershell.exe',
    args:['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-STA','-File',fixture],
  });
  let hwnd:string|undefined;
  for(let attempt=0;attempt<45;attempt++){
    const inventory=await desktop('windows.private_desktop.windows',{}) as {
      data:{inputDesktop:string;windows:Array<{title:string;hwnd:string}>};
    };
    assert.equal(inventory.data.inputDesktop,'Default');
    hwnd=inventory.data.windows.find(w=>w.title==='Nexowire Repeated Private Capture')?.hwnd;
    if(hwnd)break;
    await new Promise(resolve=>setTimeout(resolve,120));
  }
  assert.ok(hwnd,'Managed private fixture HWND must be visible');
  const topology=(await inspectWindowsPrivateDisplayTopology()).data;
  assert.ok(topology.monitorCount>0&&topology.monitorCount<=8);
  const startedAt=Date.now();
  let images=0;
  const sourceRanges=new Set<string>();
  for(let iteration=0;iteration<6;iteration++){
    const composite=(await captureWindowsPrivateScreen({
      max_width:1280,max_height:720,max_bytes:4_194_304,
    })).data;
    assert.equal(composite.source,'desktop');
    assert.equal(composite.monitorCount,topology.monitorCount);
    assert.equal(composite.inputDesktopBefore,'Default');
    assert.equal(composite.inputDesktopAfter,'Default');
    assert.equal(composite.visibleDesktopChanged,false);
    assert.ok(composite.capturedWindows>0);
    images++;

    const perMonitor=(await captureWindowsPrivateScreenSet({
      max_width:1024,max_height:768,max_bytes:4_194_304,
      max_total_bytes:16_777_216,
    })).data;
    assert.equal(perMonitor.complete,true);
    assert.equal(perMonitor.monitorCount,topology.monitorCount);
    assert.deepEqual(perMonitor.monitors,topology.monitors);
    assert.equal(perMonitor.inputDesktopAfter,'Default');
    assert.equal(perMonitor.visibleDesktopChanged,false);
    assert.ok(perMonitor.captures.every(s=>s.inputDesktopAfter==='Default'));
    images+=perMonitor.captures.length;
    for(const monitor of perMonitor.monitors){
      sourceRanges.add(monitor.id);
    }

    const chosen:WindowsPrivateScreenCapture=(await captureWindowsPrivateScreen({
      source:'window',hwnd,
      max_width:800,max_height:600,max_bytes:4_194_304,
    })).data;
    assert.equal(chosen.source,'window');
    assert.equal(chosen.capturedWindows,1);
    assert.equal(chosen.inputDesktopBefore,'Default');
    assert.equal(chosen.inputDesktopAfter,'Default');
    assert.ok(chosen.bytes>100);
    images++;
  }
  assert.equal(sourceRanges.size,topology.monitorCount);
  const ending=(await inspectWindowsPrivateDisplayTopology()).data;
  assert.deepEqual(ending.monitors,topology.monitors);
  assert.deepEqual(ending.virtualBounds,topology.virtualBounds);
  assert.equal(ending.inputDesktopBefore,ending.inputDesktopAfter);
  const windows=await desktop('windows.private_desktop.windows',{}) as {
    data:{inputDesktop:string;windows:Array<{hwnd:string}>};
  };
  assert.equal(windows.data.inputDesktop,'Default');
  assert.ok(windows.data.windows.some(w=>w.hwnd===hwnd));
  // Report measurements, but do not invent a performance SLA or claim
  // isolation over owner input paths untested by this short live soak.
  t.diagnostic(JSON.stringify({
    iterations:6,images,durationMs:Date.now()-startedAt,
    hostMonitorCount:topology.monitorCount,
    visibleDesktopChanged:false,
  }));
});
