import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {executeCapability} from '../src/agent/executors.js';
import {executeWindowsPrivateDesktopCapability} from '../src/agent/windows-private-desktop.js';
import {executeWindowsPrivateViewerCapability} from '../src/agent/windows-private-viewer.js';
import {BrowserManager} from '../src/agent/browser-manager.js';
import {PathPolicy} from '../src/agent/path-policy.js';
import {ProcessManager} from '../src/agent/process-manager.js';
import {needsPhysicalConsoleApproval} from '../src/agent/windows-console-grant.js';

interface OwnerConsoleSnapshot {
  foreground:string;
  cursorX:number;
  cursorY:number;
  lastInputTick:number;
}
const powershell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function snapshotOwnerConsole():OwnerConsoleSnapshot {
  const script=[
    "$ErrorActionPreference='Stop'",
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class NxOwnerInputProbe {',
    '  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }',
    '  [StructLayout(LayoutKind.Sequential)] public struct LastInputInfo { public uint cbSize; public uint dwTime; }',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);',
    '  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LastInputInfo p);',
    '}',
    '"@',
    '$point=New-Object NxOwnerInputProbe+Point',
    '$last=New-Object NxOwnerInputProbe+LastInputInfo',
    '$last.cbSize=[System.Runtime.InteropServices.Marshal]::SizeOf([type][NxOwnerInputProbe+LastInputInfo])',
    "if(-not [NxOwnerInputProbe]::GetCursorPos([ref]$point)){throw 'GetCursorPos failed'}",
    "if(-not [NxOwnerInputProbe]::GetLastInputInfo([ref]$last)){throw 'GetLastInputInfo failed'}",
    '[pscustomobject]@{foreground=[NxOwnerInputProbe]::GetForegroundWindow().ToInt64().ToString();cursorX=$point.X;cursorY=$point.Y;lastInputTick=[long]$last.dwTime}|ConvertTo-Json -Compress',
  ].join('\n');
  const result=spawnSync(powershell,[
    '-NoLogo','-NoProfile','-NonInteractive','-Command',script,
  ],{
    encoding:'utf8',windowsHide:true,shell:false,
    timeout:15_000,maxBuffer:512*1024,
  });
  assert.equal(result.status,0,result.stderr||String(result.error));
  const sample=JSON.parse(result.stdout.trim()) as OwnerConsoleSnapshot;
  assert.match(sample.foreground,/^\d+$/);
  assert.ok(Number.isInteger(sample.cursorX)&&Number.isInteger(sample.cursorY));
  assert.ok(Number.isInteger(sample.lastInputTick));
  return sample;
}

async function assertNoOwnerInputMutation(
  baseline:OwnerConsoleSnapshot,
  phase:string,
):Promise<void> {
  const desktop=await executeWindowsPrivateDesktopCapability(
    'windows.private_desktop.status',{},
  ) as {data:{inputDesktop:string;running:boolean}};
  assert.equal(desktop.data.inputDesktop,'Default',phase+' switched input desktop');
  assert.equal(desktop.data.running,true,phase+' unexpectedly stopped private desktop');
  const now=snapshotOwnerConsole();
  // This opt-in test requires an idle DEV session. A changed input timestamp
  // may reflect human activity, so such a result is inconclusive, not proof
  // that the AI injected physical input.
  assert.equal(now.lastInputTick,baseline.lastInputTick,
    phase+' detected physical input; rerun on an idle isolated DEV desktop');
  assert.equal(now.foreground,baseline.foreground,phase+' changed owner foreground HWND');
  assert.equal(now.cursorX,baseline.cursorX,phase+' changed physical cursor X');
  assert.equal(now.cursorY,baseline.cursorY,phase+' changed physical cursor Y');
}

test('private shell, durable process, task graph, workspace checks, headed Edge and AI viewer preserve owner focus and cursor',{
  skip:process.platform!=='win32'||process.env.NEXOWIRE_RUN_AI_FOCUS_SOAK_LIVE!=='1',
  timeout:180_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-ai-focus-soak-'));
  const previous={
    NEXOWIRE_PRIVATE_DESKTOP_DIR:process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR,
    NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT:process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT,
    NEXOWIRE_PRIVATE_VIEWER_DIR:process.env.NEXOWIRE_PRIVATE_VIEWER_DIR,
    NEXOWIRE_AI_UI_TARGET_DEFAULT:process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT,
  };
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=path.join(root,'desktop');
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  process.env.NEXOWIRE_PRIVATE_VIEWER_DIR=path.join(root,'viewer');
  process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT='private_desktop';
  const browser=new BrowserManager({rootDir:path.join(root,'profiles')});
  const processes=new ProcessManager({
    stateFile:path.join(root,'sessions.json'),
    workerRoot:path.join(root,'workers'),
    workerEntrypoint:path.resolve('src/cli.ts'),
    workerExecArgv:process.execArgv,
  });
  t.after(async()=>{
    await browser.stopAll().catch(()=>undefined);
    await processes.stopAll().catch(()=>undefined);
    await processes.shutdown().catch(()=>undefined);
    await executeWindowsPrivateViewerCapability(
      'windows.private_viewer.stop',{},
    ).catch(()=>undefined);
    await executeWindowsPrivateDesktopCapability(
      'windows.private_desktop.stop',{},
    ).catch(()=>undefined);
    for(const [name,value] of Object.entries(previous)){
      if(value===undefined)delete process.env[name];
      else process.env[name]=value;
    }
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:120})
      .catch(()=>undefined);
  });

  await executeWindowsPrivateDesktopCapability('windows.private_desktop.start',{
    create_shortcut:false,
  });
  const baseline=snapshotOwnerConsole();
  const policy=new PathPolicy(['*']);

  const shell=await executeCapability('shell.exec',{
    shell:'powershell',command:"[Console]::Write('private-focus-shell')",
    timeout_ms:15_000,
  },policy) as {stdout:string;exitCode:number|null};
  assert.equal(shell.exitCode,0);
  assert.equal(shell.stdout,'private-focus-shell');
  await assertNoOwnerInputMutation(baseline,'private shell');

  await processes.initialize();
  const session=await processes.start({
    command:"[Console]::Write('private-focus-process')",
    shell:'powershell',
  },policy);
  assert.equal(session.uiTarget,'private_desktop');
  assert.equal(session.desktopName,'NexowirePrivate');
  await processes.stop({session_id:session.sessionId});
  await assertNoOwnerInputMutation(baseline,'private durable process');

  const graph=await executeCapability('task.graph.run',{
    max_parallel:1,
    jobs:[
      {id:'compile',shell:'powershell',command:"[Console]::Write('private-graph-one')"},
      {id:'verify',shell:'powershell',depends_on:['compile'],
        command:"[Console]::Write('private-graph-two')"},
    ],
  },policy) as {data:{ok:boolean;uiTarget:string;results:Array<{stdout?:string}>}};
  assert.equal(graph.data.ok,true);
  assert.equal(graph.data.uiTarget,'private_desktop');
  assert.equal(graph.data.results[1]?.stdout,'private-graph-two');
  await assertNoOwnerInputMutation(baseline,'private dependency graph');

  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({
    name:'nexowire-focus-fixture',
    scripts:{
      test:'node -e "console.log(\'focus-test-ok\')"',
      build:'node -e "console.log(\'focus-build-ok\')"',
    },
  }));
  const checks=await executeCapability('workspace.checks',{
    path:root,checks:['node:test','node:build'],
    parallel:true,timeout_ms:25_000,
  },new PathPolicy([root])) as {data:{ok:boolean;passed:number}};
  assert.equal(checks.data.ok,true);
  assert.equal(checks.data.passed,2);
  await assertNoOwnerInputMutation(baseline,'private concurrent workspace checks');

  const headed=await browser.start({
    browser:'edge',headless:false,initialUrl:'about:blank',
  });
  assert.equal(headed.desktopName,'NexowirePrivate');
  assert.equal(headed.uiTarget,'private_desktop');
  await browser.tabs(headed.id);
  await assertNoOwnerInputMutation(baseline,'private headed Edge');
  await browser.stop(headed.id);

  const viewer=await executeWindowsPrivateViewerCapability(
    'windows.private_viewer.start',
    {refresh_ms:750,max_width:900,max_height:600,topmost:false},
  ) as {data:{running:boolean}};
  assert.equal(viewer.data.running,true);
  await assertNoOwnerInputMutation(baseline,'nonactivating AI viewer');
  await executeWindowsPrivateViewerCapability('windows.private_viewer.stop',{});
  await assertNoOwnerInputMutation(baseline,'viewer shutdown');
});

test('physical foreground and cursor remain protected in both SAFE and FULL policy',()=>{
  for(const capability of [
    'windows.window.focus',
    'windows.pointer.move',
    'windows.pointer.click',
    'windows.keyboard.type',
    'windows.private_desktop.show',
  ]){
    assert.equal(needsPhysicalConsoleApproval(capability,'safe'),true,capability);
    assert.equal(needsPhysicalConsoleApproval(capability,'full'),true,capability);
  }
  assert.equal(needsPhysicalConsoleApproval('windows.private_desktop.windows','full'),false);
});
