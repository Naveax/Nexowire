import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {assertNoObviousPrivateShellScriptBrokerInvocation} from
  '../src/agent/windows-private-shell-broker-guard.js';
import {runWindowsPrivateShell} from '../src/agent/windows-private-shell.js';
import {executeWindowsPrivateDesktopCapability as desktop} from
  '../src/agent/windows-private-desktop.js';

const isDenied=(err:unknown)=>
  err instanceof Error&&'code'in err&&
  (err.code==='AI_PRIVATE_SHELL_BROKER_NOT_ISOLATED'||
   err.code==='AI_PRIVATE_SHELL_SCRIPT_BROKER_NOT_AUDITED');

test('PowerShell -File static GUI/elevation brokerage is rejected before a private worker',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-script-gate-'));
  try{
    for(const [name,script] of [
      ['start.ps1','Write-Output ready\nStart-Process explorer.exe'],
      ['com.ps1',"$shell=New-Object -ComObject Shell.Application\n"],
      ['elevation.ps1','Start-Process .\\setup.exe -Verb RunAs'],
      ['dotnet.ps1','[System.Diagnostics.Process]::Start("notepad.exe")'],
    ] as const){
      const file=path.join(dir,name);
      await fs.writeFile(file,script,'utf8');
      for(const parameter of ['-File','-Fi','-Fil','--File','--Fi']){
        await assert.rejects(
          assertNoObviousPrivateShellScriptBrokerInvocation(
            'powershell.exe',['-NoProfile',parameter,file],
          ),isDenied,name+' '+parameter,
        );
      }
    }
    const inline=path.join(dir,'inline.ps1');
    await fs.writeFile(inline,'Start-Process explorer.exe');
    await assert.rejects(
      assertNoObviousPrivateShellScriptBrokerInvocation(
        'powershell.exe',['-File:'+inline],
      ),isDenied,
    );
    const missing=path.join(dir,'missing.ps1');
    await assert.rejects(
      assertNoObviousPrivateShellScriptBrokerInvocation('pwsh.exe',
        ['-f',missing],dir),isDenied,
    );
    const large=path.join(dir,'large.ps1');
    await fs.writeFile(large,'x'.repeat(262_145));
    await assert.rejects(
      assertNoObviousPrivateShellScriptBrokerInvocation('pwsh.exe',
        ['-File',large]),isDenied,
    );
  }finally{
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test('ordinary WPF initialization and maintenance scripts remain eligible',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-script-safe-'));
  try{
    const file=path.join(dir,'safe.ps1');
    await fs.writeFile(file,[
      "$ErrorActionPreference='Stop'",
      "Add-Type -AssemblyName PresentationFramework",
      '$window=New-Object Windows.Window',
      "$window.Title='Private fixture'",
      'Write-Output ready',
    ].join('\n'));
    await assert.doesNotReject(
      assertNoObviousPrivateShellScriptBrokerInvocation(
        'powershell.exe',['-NoProfile','-STA','-File','safe.ps1'],dir,
      ),
    );
    const wide=path.join(dir,'wide.ps1');
    await fs.writeFile(wide,Buffer.concat([
      Buffer.from([0xff,0xfe]),
      Buffer.from('Write-Output safe','utf16le'),
    ]));
    await assert.doesNotReject(
      assertNoObviousPrivateShellScriptBrokerInvocation(
        'pwsh.exe',['-f',wide],
      ),
    );
  }finally{
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test('DEV private shell rejects -File broker before creating desktop state',{
  skip:process.platform!=='win32',timeout:25_000,
},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-script-reject-'));
  const previous=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  try{
    const file=path.join(dir,'blocked.ps1');
    await fs.writeFile(file,'Start-Process explorer.exe','utf8');
    process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=path.join(dir,'must-not-exist');
    await assert.rejects(
      runWindowsPrivateShell('powershell.exe',['-NoProfile','-File',file],{
        timeoutMs:10_000,maxOutputBytes:4096,
      }),isDenied,
    );
    await assert.rejects(fs.access(path.join(dir,'must-not-exist')),
      (error:unknown)=>error instanceof Error&&'code'in error&&
        error.code==='ENOENT');
  }finally{
    if(previous===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=previous;
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test('DEV direct private desktop blocks external .ps1 broker but runs safe script',{
  skip:process.platform!=='win32',timeout:95_000,
},async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-script-accept-'));
  const previous=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const previousShortcut=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=dir;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await desktop('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(previous===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=previous;
    if(previousShortcut===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=previousShortcut;
    await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:120});
  });
  const good=path.join(dir,'good.ps1');
  const bad=path.join(dir,'bad.ps1');
  const marker=path.join(dir,'ran.txt');
  await fs.writeFile(good,"'PRIVATE_SCRIPT_RAN'|Set-Content -LiteralPath '"+
    marker.replace(/'/g,"''")+"' -Encoding UTF8");
  await fs.writeFile(bad,'Start-Process explorer.exe');
  const started=await desktop('windows.private_desktop.start',{
    create_shortcut:false,
  }) as {data:{running:boolean;inputDesktop:string}};
  assert.equal(started.data.running,true);
  assert.equal(started.data.inputDesktop,'Default');
  await assert.rejects(
    desktop('windows.private_desktop.launch',{
      executable:'powershell.exe',
      args:['-NoProfile','-ExecutionPolicy','Bypass','-File',bad],
    }),isDenied,
  );
  const launch=await desktop('windows.private_desktop.launch',{
    executable:'powershell.exe',
    args:['-NoProfile','-ExecutionPolicy','Bypass','-File',good],
  })as{data:{pid:number}};
  assert.ok(launch.data.pid>0);
  let content='';
  for(let i=0;i<30;i++){
    content=await fs.readFile(marker,'utf8').catch(()=>'');
    if(content.includes('PRIVATE_SCRIPT_RAN'))break;
    await new Promise(resolve=>setTimeout(resolve,125));
  }
  assert.ok(content.includes('PRIVATE_SCRIPT_RAN'));
  const status=await desktop('windows.private_desktop.status',{})as{
    data:{inputDesktop:string;running:boolean}};
  assert.equal(status.data.inputDesktop,'Default');
  assert.equal(status.data.running,true);
});
