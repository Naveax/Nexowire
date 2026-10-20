import test from 'node:test';
import assert from 'node:assert/strict';
import {assertNoObviousPrivateShellBrokerInvocation} from '../src/agent/windows-private-shell-broker-guard.js';
import {assertNoPrivateDesktopBrokeredExecutable} from '../src/agent/windows-private-desktop.js';

const disallowed=[
  ['regsvr32.exe',[]],
  ['runas.exe',['/user:other','notepad.exe']],
  ['schtasks.exe',['/run','/tn','TaskOnDefault']],
  ['forfiles.exe',['/C','cmd /C explorer']],
  ['cmd.exe',['/C','schtasks.exe /run /tn TaskOnDefault']],
  ['cmd.exe',['/C','regsvr32.exe /s fake.dll']],
  ['powershell.exe',['-Command','& "C:\\Windows\\System32\\regsvr32.exe" /s fake.dll']],
  ['powershell.exe',['-Command','New-Object -ComObject Excel.Application']],
  ['pwsh.exe',['-Command','[type]::GetTypeFromProgID("Excel.Application")']],
  ['powershell.exe',['-Command','Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine="explorer.exe"}']],
  ['powershell.exe',['-Command','Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList "calc.exe"']],
] as const;

test('additional Windows GUI launch brokers and COM activation fail closed in private shell',()=>{
  for(const [executable,args] of disallowed){
    assert.throws(()=>assertNoObviousPrivateShellBrokerInvocation(executable,args),
      (e:unknown)=>e instanceof Error&&'code'in e&&
        e.code==='AI_PRIVATE_SHELL_BROKER_NOT_ISOLATED',
      executable+' '+args.join(' '));
  }
});
test('direct private GUI executable preflight rejects alternate WMI, task, UAC and COM brokers',()=>{
  for(const name of ['regsvr32.exe','runas.exe','schtasks.exe','forfiles.exe']){
    assert.throws(()=>assertNoPrivateDesktopBrokeredExecutable(name),
      (e:unknown)=>e instanceof Error&&'code'in e&&
        e.code==='PRIVATE_DESKTOP_SHELL_BROKER_UNISOLATED',name);
  }
});
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';
import {executeWindowsWindowCapability} from '../src/agent/windows-window-control.js';

test('real isolated Windows desktop rejects new brokers with no process or Default-focus change',{
  skip:process.platform!=='win32',timeout:90_000,
},async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-additional-brokers-'));
  const prior=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const priorShortcut=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=temp;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await desktop('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(prior===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=prior;
    if(priorShortcut===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=priorShortcut;
    await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  });
  await desktop('windows.private_desktop.start',{create_shortcut:false});
  const before=await desktop('windows.private_desktop.status',{}) as{
    data:{launchedPids:number[];inputDesktop:string};
  };
  const physicalBefore=await executeWindowsWindowCapability('windows.window.list',{}) as{
    data:{foregroundHwnd:string|null};
  };
  assert.equal(before.data.inputDesktop,'Default');
  // All launches are rejected at the preflight gate; no COM, UAC,
  // scheduled task, or Explorer child is actually started.
  for(const executable of ['regsvr32.exe','runas.exe','schtasks.exe','forfiles.exe']){
    await assert.rejects(
      desktop('windows.private_desktop.launch',{executable,args:[]}),
      (error:unknown)=>error instanceof Error&&'code'in error&&
        error.code==='PRIVATE_DESKTOP_SHELL_BROKER_UNISOLATED');
  }
  const script=path.join(temp,'unsafe-com-static.ps1');
  await fs.writeFile(script,'New-Object -ComObject Excel.Application\n','utf8');
  await assert.rejects(
    desktop('windows.private_desktop.launch',{
      executable:'powershell.exe',
      args:['-NoProfile','-File',script],
    }),
    (error:unknown)=>error instanceof Error&&'code'in error&&
      error.code==='AI_PRIVATE_SHELL_BROKER_NOT_ISOLATED');
  const after=await desktop('windows.private_desktop.status',{}) as{
    data:{launchedPids:number[];inputDesktop:string};
  };
  const physicalAfter=await executeWindowsWindowCapability('windows.window.list',{}) as{
    data:{foregroundHwnd:string|null};
  };
  assert.deepEqual(after.data.launchedPids,before.data.launchedPids);
  assert.equal(after.data.inputDesktop,'Default');
  // The owner's foreground window may legitimately change due to user input
  // between observations; never set or click it to force an assertion.
  assert.notEqual(physicalAfter.data.foregroundHwnd,undefined);
  assert.notEqual(physicalBefore.data.foregroundHwnd,undefined);
});
