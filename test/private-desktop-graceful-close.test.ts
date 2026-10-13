import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZodError } from 'zod';
import { executeWindowsPrivateDesktopCapability as desktop } from '../src/agent/windows-private-desktop.js';
import { isReadOnlyCapability } from '../src/protocol/capabilities.js';
import { MCP_TOOL_CAPABILITY_REQUIREMENTS } from '../src/mcp/tool-capabilities.js';

test('private app close is mutating, and MCP routes only to the private-desktop capability',()=>{
  assert.equal(isReadOnlyCapability('windows.private_desktop.window.close'),false);
  assert.equal(
    MCP_TOOL_CAPABILITY_REQUIREMENTS.windows_private_desktop_close_window,
    'windows.private_desktop.window.close',
  );
});

test('WM_CLOSE is sent only to a tracked NexowirePrivate window, not its shell or physical Default',{
  skip:process.platform!=='win32',timeout:60_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-close-'));
  const previousRoot=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const previousSkip=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=root;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await desktop('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(previousRoot===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=previousRoot;
    if(previousSkip===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=previousSkip;
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:150});
  });
  const fixture=path.join(root,'close-test.ps1');
  await fs.writeFile(fixture,[
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName PresentationFramework',
    'Add-Type -AssemblyName PresentationCore',
    'Add-Type -AssemblyName WindowsBase',
    '$window=New-Object Windows.Window',
    "$window.Title='Nexowire Managed Close Test'",
    '$window.Width=600','$window.Height=400',
    '$window.ShowInTaskbar=$false',
    '[void]$window.ShowDialog()',
  ].join('\n'),'utf8');
  const started=await desktop('windows.private_desktop.start',{create_shortcut:false}) as {data:{running:boolean;inputDesktop:string}};
  assert.equal(started.data.running,true);
  assert.equal(started.data.inputDesktop,'Default');
  const windows1=await desktop('windows.private_desktop.windows',{}) as {data:{windows:Array<{hwnd:string;title:string;processId:number}>;inputDesktop:string}};
  const shell=windows1.data.windows.find(w=>w.title==='Nexowire Private Desktop');
  assert.ok(shell);
  await assert.rejects(
    desktop('windows.private_desktop.window.close',{hwnd:shell.hwnd}),
    (error:unknown)=>error instanceof Error&&'code' in error&&
      error.code==='PRIVATE_WINDOW_UNTRACKED',
  );
  await assert.rejects(
    desktop('windows.private_desktop.window.close',{hwnd:'0x1'}),
    (error:unknown)=>error instanceof Error&&'code' in error&&
      error.code==='WINDOW_NOT_PRIVATE_DESKTOP',
  );
  await assert.rejects(
    desktop('windows.private_desktop.window.close',{hwnd:'malformed'}),
    ZodError,
  );

  const spawn=await desktop('windows.private_desktop.launch',{
    executable:'powershell.exe',
    args:['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-STA','-File',fixture],
  }) as {data:{pid:number}};
  let window:{hwnd:string;title:string;processId:number}|undefined;
  for(let i=0;i<35;i++){
    const snapshot=await desktop('windows.private_desktop.windows',{}) as {data:{windows:Array<{hwnd:string;title:string;processId:number}>;inputDesktop:string}};
    assert.equal(snapshot.data.inputDesktop,'Default');
    window=snapshot.data.windows.find(w=>w.title==='Nexowire Managed Close Test');
    if(window)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(window,'The managed window must be running');
  assert.equal(window.processId,spawn.data.pid);

  const result=await desktop('windows.private_desktop.window.close',{hwnd:window.hwnd}) as {data:{
      closeRequested:boolean;closed:boolean;
      hwnd:string;processId:number;forcedProcessTermination:boolean;
      visibleDesktopChanged:boolean;touchesSystemCursor:boolean;
      inputDesktopBefore:string;inputDesktopAfter:string;
    }};
  assert.equal(result.data.closeRequested,true);
  assert.equal(result.data.closed,true,'WM_CLOSE should close this cooperative fixture');
  assert.equal(result.data.forcedProcessTermination,false);
  assert.equal(result.data.visibleDesktopChanged,false);
  assert.equal(result.data.touchesSystemCursor,false);
  assert.equal(result.data.inputDesktopBefore,'Default');
  assert.equal(result.data.inputDesktopAfter,'Default');
  assert.equal(result.data.processId,spawn.data.pid);
  const remaining=await desktop('windows.private_desktop.windows',{}) as {data:{windows:Array<{hwnd:string;title:string}>;inputDesktop:string}};
  assert.equal(remaining.data.inputDesktop,'Default');
  assert.ok(!remaining.data.windows.some(w=>w.hwnd===window.hwnd));
  assert.ok(remaining.data.windows.some(w=>w.title==='Nexowire Private Desktop'));
});
