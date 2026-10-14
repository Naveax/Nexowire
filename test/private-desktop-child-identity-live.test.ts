import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {runWindowsPrivateShell} from '../src/agent/windows-private-shell.js';
import {executeWindowsPrivateDesktopCapability} from '../src/agent/windows-private-desktop.js';

const definition=[
  'using System;',
  'using System.Text;',
  'using System.Runtime.InteropServices;',
  'public static class NxPrivateDesktopProbe {',
  ' [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
  ' [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint tid);',
  ' [DllImport("user32.dll", CharSet=CharSet.Unicode,SetLastError=true)]',
  ' public static extern bool GetUserObjectInformation(IntPtr h,int index,StringBuilder b,int len,out int needed);',
  ' public static string Current(){',
  '  IntPtr d=GetThreadDesktop(GetCurrentThreadId());',
  '  if(d==IntPtr.Zero)throw new Exception("NO_THREAD_DESKTOP");',
  '  int n;GetUserObjectInformation(d,2,null,0,out n);',
  '  if(n<=0)throw new Exception("NO_DESKTOP_NAME_LENGTH");',
  '  var b=new StringBuilder(n/2+4);',
  '  if(!GetUserObjectInformation(d,2,b,b.Capacity*2,out n))throw new Exception("DESKTOP_NAME_UNAVAILABLE");',
  '  return b.ToString();',
  ' }',
  '}',
].join('\n');

test('DEV child process reports private desktop via Win32 GetThreadDesktop', {
  skip:process.platform!=='win32'||process.env.NEXOWIRE_RUN_PRIVATE_DESKTOP_IDENTITY_LIVE!=='1',
  timeout:90_000,
}, async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-desktop-identity-'));
  const prior=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const shortcut=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=root;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await executeWindowsPrivateDesktopCapability('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(prior===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=prior;
    if(shortcut===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=shortcut;
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:120});
  });
  const command=[
    "$ErrorActionPreference='Stop'",
    "$definition=@'",
    definition,
    "'@",
    "Add-Type -TypeDefinition $definition -ErrorAction Stop",
    "[Console]::WriteLine('THREAD_DESKTOP='+[NxPrivateDesktopProbe]::Current())",
  ].join('\n');
  const result=await runWindowsPrivateShell('powershell.exe',[
    '-NoProfile','-NonInteractive','-Command',command,
  ],{timeoutMs:30_000,maxOutputBytes:8192});
  assert.equal(result.exitCode,0,result.stderr);
  assert.match(result.stdout,/THREAD_DESKTOP=NexowirePrivate/);
  const status=await executeWindowsPrivateDesktopCapability('windows.private_desktop.status',{}) as{
    data:{inputDesktop:string;running:boolean};
  };
  assert.equal(status.data.running,true);
  assert.equal(status.data.inputDesktop,'Default');
});
