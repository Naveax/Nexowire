import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,promises as fs} from 'node:fs';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {executeWindowsPrivateDesktopCapability} from '../src/agent/windows-private-desktop.js';
import {executeWindowsPrivateViewerCapability} from '../src/agent/windows-private-viewer.js';

test('AI viewer uses non-activating WPF window and hides its launcher console',()=>{
  const source=readFileSync(new URL('../src/agent/windows-private-viewer.ts',import.meta.url),'utf8');
  assert.match(source,/\$window\.ShowActivated = \$false/);
  assert.match(source,/windowsHide: true/);
  assert.match(source,/System32\\\\WindowsPowerShell\\\\v1\.0\\\\powershell\.exe/);
  assert.doesNotMatch(source,/windowsHide: false/);
  for(const fragment of [
    'COMPACT PREVIEW','EXPAND PREVIEW','Update-WindowList',
    'refreshPrivateWindowInventory','-WindowsPath',
    "windows.private_desktop.windows",
    "$window.ShowActivated = $false",
  ])assert.ok(source.includes(fragment),fragment);
});

function foregroundHwnd():string{
  const script=[
    "$ErrorActionPreference='Stop'",
    "Add-Type -Namespace NxProbe -Name Foreground -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow();'",
    '[NxProbe.Foreground]::GetForegroundWindow().ToInt64()',
  ].join('\n');
  const run=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',[
    '-NoLogo','-NoProfile','-NonInteractive','-Command',script,
  ],{encoding:'utf8',windowsHide:true,timeout:10_000});
  if(run.error||run.status!==0)throw new Error('FOREGROUND_READ_FAILED');
  return run.stdout.trim();
}

test('AI viewer opens without foreground focus theft while private desktop remains isolated',{
  skip:process.platform!=='win32'||process.env.NEXOWIRE_RUN_VIEWER_NOACTIVATE_LIVE!=='1',
  timeout:80_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-viewer-noactivate-'));
  const keys={
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
    for(const [key,value] of Object.entries(keys)){
      if(value===undefined)delete process.env[key];
      else process.env[key]=value;
    }
    await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100}).catch(()=>undefined);
  });
  await executeWindowsPrivateDesktopCapability('windows.private_desktop.start',{
    create_shortcut:false,
  });
  const before=foregroundHwnd();
  const started=await executeWindowsPrivateViewerCapability(
    'windows.private_viewer.start',{
      refresh_ms:750,max_width:900,max_height:600,topmost:false,
    },
  ) as {data:{running:boolean}};
  assert.equal(started.data.running,true);
  const inventory=JSON.parse(
    await fs.readFile(path.join(root,'viewer','windows.json'),'utf8'),
  ) as {windows:unknown[];updatedAt:string};
  assert.ok(Array.isArray(inventory.windows));
  assert.ok(inventory.windows.length<=24);
  assert.ok(typeof inventory.updatedAt==='string');
  const after=foregroundHwnd();
  if(before!=='0'&&after!=='0')assert.equal(after,before);
  const desktop=await executeWindowsPrivateDesktopCapability(
    'windows.private_desktop.status',{},
  ) as {data:{inputDesktop:string}};
  assert.equal(desktop.data.inputDesktop,'Default');
});
