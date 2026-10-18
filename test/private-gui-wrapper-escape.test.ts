import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {assertNoObviousPrivateShellBrokerInvocation} from '../src/agent/windows-private-shell-broker-guard.js';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';

const denied=(e:unknown)=>e instanceof Error&&'code' in e&&
  (e.code==='AI_PRIVATE_SHELL_BROKER_NOT_ISOLATED'||
   e.code==='PRIVATE_DESKTOP_SHELL_BROKER_UNISOLATED'||
   e.code==='PRIVATE_DESKTOP_OPAQUE_WRAPPER_UNISOLATED');
const bypasses=[
  ['cmd.exe',['/C','wsl.exe --list --quiet']],
  ['cmd.exe',['/C','wt.exe -w 0 new-tab']],
  ['cmd.exe',['/D','/S','/C','echo harmless && bash.exe -c echo nope']],
  ['cmd.exe',['/C','"C:\\Windows\\System32\\wsl.exe" --list']],
  ['cmd.exe',['/C','echo dummy & start /b wsl.exe']],
  ['powershell.exe',['-NoProfile','-Command','& wsl.exe -l -q']],
  ['pwsh.exe',['-Command','wt -w 0 new-tab']],
  ['powershell.exe',['-Command','& "C:\\Windows\\System32\\wsl.exe" -l -q']],
  ['powershell.exe',['-Command','wsl --list']],
  ['powershell.exe',['-Command','& bash -c "echo test"']],
  ['cmd.exe',['/C','wslhost.exe']],
  ['cmd.exe',['/C','C:\\Windows\\System32\\wt.exe']],
] as const;

test('nested WSL, WSLg and Windows Terminal targets fail closed before wrapper creation',()=>{
  for(const [executable,args] of bypasses){
    assert.throws(()=>assertNoObviousPrivateShellBrokerInvocation(executable,args),
      denied,executable+' '+args.join(' '));
  }
});

test('direct private launch refuses opaque shell command wrappers before creating a process',{
  skip:process.platform!=='win32',timeout:70_000,
},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-wrapper-deny-'));
  const prior=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const priorSkip=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=root;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await desktop('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(prior===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=prior;
    if(priorSkip===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=priorSkip;
    await fs.rm(root,{force:true,recursive:true,maxRetries:5,retryDelay:100});
  });
  await desktop('windows.private_desktop.start',{create_shortcut:false});
  const before=await desktop('windows.private_desktop.status',{}) as{
    data:{launchedPids:number[];inputDesktop:string};
  };
  // Even a harmless-looking wrapper can dispatch GUI through environment
  // expansion, shell aliases, imports or dynamic COM. It has no safe static
  // isolation guarantee on the native private desktop.
  for(const entry of [
    ...bypasses.map(([executable,args])=>({executable,args:[...args]})),
    {executable:'cmd.exe',args:['/C','echo harmless']},
    {executable:'powershell.exe',args:['-NoProfile','-Command','Write-Output harmless']},
    {executable:'pwsh.exe',args:['-Command','Get-Date']},
    {executable:'node.exe',args:['-e','require("child_process").spawn("wsl.exe")']},
    {executable:'python.exe',args:['-c','import subprocess; subprocess.run(["wsl.exe"])']},
    {executable:'node.exe',args:['some-script.js']},
    {executable:'python.exe',args:['some-script.py']},
    {executable:'git.exe',args:['status']},
    {executable:'WindowsTerminal.exe',args:[]},
    {executable:'wslconfig.exe',args:[]},
  ]){
    await assert.rejects(
      desktop('windows.private_desktop.launch',entry),denied,
      entry.executable+' '+entry.args.join(' '));
  }
  const after=await desktop('windows.private_desktop.status',{}) as{
    data:{launchedPids:number[];inputDesktop:string};
  };
  assert.deepEqual(after.data.launchedPids,before.data.launchedPids);
  assert.equal(after.data.inputDesktop,'Default');
});
