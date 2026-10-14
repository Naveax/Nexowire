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
  ['pwsh.exe',['--ec','AAA=']],
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

test('quoted and chained CMD nested shell brokers fail closed',()=>{
  const cases=[
    ['cmd.exe',['/C','"start "" explorer.exe"']],
    ['cmd.exe',['/D','/S','/C','""explorer.exe" C:\\Windows"']],
    ['cmd.exe',['/C','pwsh.exe -EncodedCommand QQ==']],
    ['cmd.exe',['/C','"powershell.exe -NoProfile -Command Write-Output okay"']],
    ['cmd.exe',['/C','echo okay && pwsh -Command Write-Output hello']],
    ['cmd.exe',['/C','call cmd.exe /C echo okay']],
    ['cmd.exe',['/Cstart "" explorer.exe']],
    ['"C:\\Windows\\explorer.exe"',[]],
    ['"C:\\Windows\\System32\\rundll32.exe"',['shell32.dll,Control_RunDLL']],
    ['powershell.exe',['-Command','& pwsh.exe -EncodedCommand QQ==']],
  ] as const;
  for(const [executable,args] of cases){
    assert.throws(
      ()=>assertNoObviousPrivateShellBrokerInvocation(executable,args),
      (error:unknown)=>error instanceof Error&&'code' in error&&
        error.code==='AI_PRIVATE_SHELL_BROKER_NOT_ISOLATED',
      executable+' '+args.join(' '),
    );
  }
});

test('quoted harmless CMD and direct PowerShell inspection remain eligible',()=>{
  for(const [executable,args] of [
    ['cmd.exe',['/C','"echo private worker okay"']],
    ['cmd.exe',['/C','echo hello && node --version']],
    ['powershell.exe',['-NoProfile','-Command','Write-Output nested-shell-no-execution']],
    ['pwsh.exe',['-Command','Get-Process | Select-Object Id']],
  ] as const){
    assert.doesNotThrow(
      ()=>assertNoObviousPrivateShellBrokerInvocation(executable,args),
      executable+' '+args.join(' '),
    );
  }
});

test('real DEV rejects quoted CMD and nested interpreters before allocating private desktop files',{
  skip:process.platform!=='win32',
},async()=>{
  const root=path.join(os.tmpdir(),'nx-private-quoted-cmd-guard-'+process.pid);
  await fs.rm(root,{recursive:true,force:true});
  const prior=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=root;
  try{
    for(const [executable,args] of [
      ['cmd.exe',['/D','/S','/C','"start "" explorer.exe"']],
      ['cmd.exe',['/C','pwsh.exe -EncodedCommand QQ==']],
      ['powershell.exe',['-Command','& cmd.exe /C echo okay']],
    ] as const){
      await assert.rejects(
        runWindowsPrivateShell(executable,args,{timeoutMs:8_000,maxOutputBytes:4096}),
        (error:unknown)=>error instanceof Error&&'code' in error&&
          error.code==='AI_PRIVATE_SHELL_BROKER_NOT_ISOLATED',
      );
    }
    await assert.rejects(fs.access(root),
      (error:unknown)=>error instanceof Error&&'code' in error&&error.code==='ENOENT');
  }finally{
    if(prior===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=prior;
  }
});

test('extensionless Windows broker names are refused by shell preflight',()=>{
  for(const [executable,args] of [
    ['explorer',[]],
    ['C:\\Windows\\explorer',[]],
    ['control',[]],
    ['rundll32',['shell32.dll,Control_RunDLL']],
    ['cmd.exe',['/C','explorer']],
    ['cmd.exe',['/C','"control"']],
    ['powershell.exe',['-Command','& rundll32 shell32.dll,Control_RunDLL']],
    ['pwsh.exe',['-Command','explorer']],
  ] as const){
    assert.throws(
      ()=>assertNoObviousPrivateShellBrokerInvocation(executable,args),
      (error:unknown)=>error instanceof Error&&'code' in error&&
        error.code==='AI_PRIVATE_SHELL_BROKER_NOT_ISOLATED',
      executable+' '+args.join(' '),
    );
  }
});
