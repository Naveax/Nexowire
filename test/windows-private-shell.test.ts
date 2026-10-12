import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {executeCapability} from '../src/agent/executors.js';
import {executeWindowsPrivateDesktopCapability} from '../src/agent/windows-private-desktop.js';
import {PathPolicy} from '../src/agent/path-policy.js';
import {runWindowsPrivateShell,privateShellExecutionEnvironment} from '../src/agent/windows-private-shell.js';

test('private shell requires a Windows desktop and bounded command settings',async()=>{
  if(process.platform!=='win32'){
    await assert.rejects(
      runWindowsPrivateShell('cmd.exe',['/C','echo hi'],{
        timeoutMs:1000,maxOutputBytes:4096,
      }),/PRIVATE_SHELL_WINDOWS_ONLY/);
    return;
  }
  await assert.rejects(
    runWindowsPrivateShell('cmd.exe',['/C','echo hi'],{
      timeoutMs:10,maxOutputBytes:4096,
    }),/PRIVATE_SHELL_LIMITS_INVALID/);
});

test('private shell inherits normal paths but not agent secrets or Node injection hooks',()=>{
  const values=privateShellExecutionEnvironment({
    PATH:'C:\\Windows\\System32',
    USERPROFILE:'C:\\Users\\test',
    NEXOWIRE_SESSION_TOKEN:'do-not-copy',
    GITHUB_TOKEN:'do-not-copy',
    NODE_OPTIONS:'--require attacker.js',
    TEMP:'C:\\Temp',
    APPDATA:'C:\\Users\\test\\AppData\\Roaming',
  });
  assert.equal(values.PATH,'C:\\Windows\\System32');
  assert.equal(values.TEMP,'C:\\Temp');
  assert.equal(values.USERPROFILE,'C:\\Users\\test');
  assert.equal(values.NEXOWIRE_SESSION_TOKEN,undefined);
  assert.equal(values.GITHUB_TOKEN,undefined);
  assert.equal(values.NODE_OPTIONS,undefined);
  assert.equal(privateShellExecutionEnvironment({PATH:'C:\\test\\n'+String.fromCharCode(10)}).PATH,undefined);
});

test('shell_exec remains backwards-compatible while private target is opt-in',async()=>{
  const policy=new PathPolicy(['*']);
  const normal=await executeCapability('shell.exec',{
    command:'echo nexowire-headless',shell:process.platform==='win32'?'cmd':'sh',
    timeout_ms:10_000,
  },policy) as {stdout:string;exitCode:number|null};
  assert.equal(normal.exitCode,0);
  assert.match(normal.stdout,/nexowire-headless/);
  if(process.platform!=='win32'){
    await assert.rejects(executeCapability('shell.exec',{
      command:'echo hi',ui_target:'private_desktop',
    },policy),/PRIVATE_SHELL_WINDOWS_ONLY/);
  }
});

test('real Windows private shell retains console focus and captures output',{
  skip:process.platform!=='win32'||process.env.NEXOWIRE_RUN_PRIVATE_SHELL_LIVE!=='1',
  timeout:60_000,
},async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-private-shell-live-'));
  const beforeRoot=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const beforeShortcut=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=dir;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    try{
      await executeWindowsPrivateDesktopCapability('windows.private_desktop.stop',{});
    }finally{
      if(beforeRoot===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
      else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=beforeRoot;
      if(beforeShortcut===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
      else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=beforeShortcut;
      await fs.rm(dir,{recursive:true,force:true}).catch(()=>undefined);
    }
  });
  const policy=new PathPolicy(['*']);
  const response=await executeCapability('shell.exec',{
    shell:'powershell',
    ui_target:'private_desktop',
    command:"[Console]::Write('nexowire-private-output'); [Console]::Error.Write('private-stderr')",
    timeout_ms:15_000,
  },policy) as {
    stdout:string;stderr:string;exitCode:number|null;data:{timedOut:boolean};
  };
  assert.equal(response.exitCode,0);
  assert.equal(response.stdout,'nexowire-private-output');
  assert.equal(response.stderr,'private-stderr');
  assert.equal(response.data.timedOut,false);
  const status=await executeWindowsPrivateDesktopCapability(
    'windows.private_desktop.status',{},
  ) as {data:{running:boolean;visibleDesktopChanged:boolean;inputDesktop:string}};
  assert.equal(status.data.running,true);
  assert.equal(status.data.inputDesktop,'Default');
});
