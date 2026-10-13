import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertNoPrivateDesktopBrokeredExecutable,
  executeWindowsPrivateDesktopCapability as desktop,
} from '../src/agent/windows-private-desktop.js';

test('known shell, COM, UAC and installer brokers are blocked before any native launch',()=>{
  for(const executable of [
    'explorer.exe','EXPLORER.EXE',
    'C:\\Windows\\explorer.exe',
    'C:/Windows/explorer.exe',
    '"C:\\Windows\\explorer.exe"',
    'control.exe',
    'rundll32.exe',
    'dllhost.exe',
    'mshta.exe','wscript.exe','cscript.exe','msiexec.exe',
    'fodhelper.exe','computerdefaults.exe','eventvwr.exe',
    'sdclt.exe','slui.exe','hh.exe',
  ]){
    assert.throws(()=>assertNoPrivateDesktopBrokeredExecutable(executable),
      (error:unknown)=>error instanceof Error&&
        'code' in error&&
        error.code==='PRIVATE_DESKTOP_SHELL_BROKER_UNISOLATED',
      executable);
  }
});

test('directly attached browsers, editors and shell interpreters remain eligible',()=>{
  for(const executable of [
    'powershell.exe','pwsh.exe','cmd.exe','notepad.exe',
    'chrome.exe','msedge.exe','firefox.exe',
    'Code.exe','python.exe','node.exe','git.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ])assert.doesNotThrow(()=>assertNoPrivateDesktopBrokeredExecutable(executable),
    executable);
});

test('real private desktop refuses shell broker before creating a GUI window',{
  skip:process.platform!=='win32',timeout:50_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-broker-deny-'));
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
  const initial=await desktop('windows.private_desktop.start',{
    create_shortcut:false,
  }) as {data:{running:boolean;inputDesktop:string}};
  assert.equal(initial.data.running,true);
  assert.equal(initial.data.inputDesktop,'Default');
  const before=await desktop('windows.private_desktop.status',{}) as {data:{launchedPids:number[];inputDesktop:string}};
  for(const executable of [
    'explorer.exe','C:\\Windows\\explorer.exe',
    'control.exe','rundll32.exe','msiexec.exe',
  ]){
    await assert.rejects(
      desktop('windows.private_desktop.launch',{executable,args:[]}),
      (error:unknown)=>error instanceof Error&&
        'code' in error&&error.code==='PRIVATE_DESKTOP_SHELL_BROKER_UNISOLATED',
      executable);
  }
  for(const entry of [
    {executable:'powershell.exe',args:['-NoProfile','-Command','Start-Process explorer.exe']},
    {executable:'pwsh.exe',args:['-Command','Invoke-Item .\\example.txt']},
    {executable:'cmd.exe',args:['/C','start "" explorer.exe']},
    {executable:'powershell.exe',args:['-EncodedCommand','U3RhcnQtUHJvY2Vzcw==']},
  ]){
    await assert.rejects(
      desktop('windows.private_desktop.launch',entry),
      (error:unknown)=>error instanceof Error&&
        'code' in error&&error.code==='AI_PRIVATE_SHELL_BROKER_NOT_ISOLATED',
      entry.executable+' '+entry.args.join(' '));
  }
  const after=await desktop('windows.private_desktop.status',{}) as {data:{launchedPids:number[];inputDesktop:string}};
  assert.deepEqual(after.data.launchedPids,before.data.launchedPids);
  assert.equal(after.data.inputDesktop,'Default');
});
