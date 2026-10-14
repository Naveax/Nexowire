import test from 'node:test';
import assert from 'node:assert/strict';
import {ProcessManager} from '../src/agent/process-manager.js';
import {PathPolicy} from '../src/agent/path-policy.js';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertNoObviousPrivateShellBrokerInvocation,
  runWindowsPrivateShell,
} from '../src/agent/windows-private-shell.js';

const blocked=[
  ['powershell.exe',['-NoProfile','-Command','Start-Process explorer.exe']],
  ['pwsh.exe',['-Command','Write-Output hello; Start-Process notepad.exe']],
  ['pwsh.exe',['-Command','Start-Process setup.exe -Verb RunAs']],
  ['pwsh.exe',['-Command','Invoke-Item .\\file.txt']],
  ['pwsh.exe',['-Command','New-Object -ComObject Shell.Application']],
  ['pwsh.exe',['-Command','[System.Diagnostics.Process]::Start("explorer.exe")']],
  ['pwsh.exe',['-EncodedCommand','AAA=']],
  ['pwsh.exe',['-En','AAA=']],
  ['pwsh.exe',['-ec','AAA=']],
  ['pwsh.exe',['--ec','AAA=']]
  ['pwsh.exe',['-EncodedCommand:AAA=']],
  ['pwsh.exe',['-CommandWithArgs','Start-Process explorer.exe']],
  ['pwsh.exe',['-cwa','Start-Process explorer.exe']],
  ['pwsh.exe',['--cwa','Start-Process explorer.exe']],
  ['pwsh.exe',['--EncodedCommand','AAA=']],
  ['pwsh.exe',['--Command','Start-Process explorer.exe']],
  ['pwsh.exe',['-Co','Start-Process explorer.exe']],
  ['powershell.exe',['-Comm','Invoke-Item .\\file.txt']],
  ['pwsh.exe',['-Command:Start-Process explorer.exe']],
  ['cmd.exe',['/D','/S','/C','start "" explorer.exe']],
  ['cmd.exe',['/C','explorer.exe .']],
  ['cmd.exe',['/C','echo hello & msiexec.exe /i package.msi']],
  ['explorer.exe',[]],
  ['C:\\Windows\\System32\\rundll32.exe',['shell32.dll,Control_RunDLL']],
] as const;

test('explicit native Windows GUI/shell broker entry points are refused before private shell start',()=>{
  for(const [executable,args] of blocked){
    assert.throws(
      ()=>assertNoObviousPrivateShellBrokerInvocation(executable,args),
      (error:unknown)=>error instanceof Error&&'code' in error&&
        error.code==='AI_PRIVATE_SHELL_BROKER_NOT_ISOLATED',
      executable+' '+args.join(' '),
    );
  }
});

test('ordinary build/test/inspection commands are unaffected by broker guard',()=>{
  for(const [executable,args] of [
    ['powershell.exe',['-NoProfile','-Command','Write-Output okay; Get-Date']],
    ['pwsh.exe',['-Command','npm run build']],
    ['pwsh.exe',['-Command','Get-Content package.json | Select-String scripts']],
    ['cmd.exe',['/D','/S','/C','echo private command']],
    ['cmd.exe',['/C','node --test test/foo.test.ts']],
    ['node.exe',['-e','console.log("hello")']],
  ] as const){
    assert.doesNotThrow(
      ()=>assertNoObviousPrivateShellBrokerInvocation(executable,args),
      executable+' '+args.join(' '),
    );
  }
});

test('durable private process worker also blocks broker commands before creating its work directory',{
  skip:process.platform!=='win32',
},async()=>{
  const root=path.join(os.tmpdir(),'nx-private-broker-no-workdir-'+process.pid);
  await fs.rm(root,{recursive:true,force:true});
  const manager=new ProcessManager({
    workerRoot:root,
    workerEntrypoint:path.join(root,'unreachable.cjs'),
  });
  await assert.rejects(manager.start({
    command:'Start-Process explorer.exe',
    shell:'powershell',
    ui_target:'private_desktop',
  },new PathPolicy(['*'])),
  (error:unknown)=>error instanceof Error&&'code' in error&&
    error.code==='AI_PRIVATE_SHELL_BROKER_NOT_ISOLATED');
  await assert.rejects(fs.access(root),
    (error:unknown)=>error instanceof Error&&'code' in error&&error.code==='ENOENT');
});

test('real DEV refuses obvious escape without starting a private shell process',{
  skip:process.platform!=='win32',
},async()=>{
  const root=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR='C:\\NexowireThisPathMustNotBeCreatedForBrokerGuard';
  try{
    await assert.rejects(
      runWindowsPrivateShell('powershell.exe',[
        '-NoProfile','-Command','Start-Process explorer.exe',
      ],{timeoutMs:12_000,maxOutputBytes:4096}),
      (error:unknown)=>error instanceof Error&&'code' in error&&
        error.code==='AI_PRIVATE_SHELL_BROKER_NOT_ISOLATED',
    );
  }finally{
    if(root===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=root;
  }
});
