import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isReadOnlyCapability} from '../src/protocol/capabilities.js';
import {MCP_TOOL_CAPABILITY_REQUIREMENTS} from '../src/mcp/tool-capabilities.js';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';

test('private child control discovery is read-only and mapped into MCP',()=>{
  assert.equal(isReadOnlyCapability('windows.private_desktop.controls'),true);
  assert.equal(MCP_TOOL_CAPABILITY_REQUIREMENTS.windows_private_desktop_controls,
    'windows.private_desktop.controls');
});

test('real private child HWND inventory provides bounded geometry and no text',{
  skip:process.platform!=='win32',timeout:105_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-controls-'));
  const previous=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const previousShortcut=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=root;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await desktop('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(previous===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=previous;
    if(previousShortcut===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=previousShortcut;
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:150});
  });
  const script=path.join(root,'controls-fixture.ps1');
  await fs.writeFile(script,[
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$w=New-Object System.Windows.Forms.Form',
    "$w.Text='Nx Private Controls Inventory'",
    '$w.ClientSize=New-Object System.Drawing.Size(540,320)',
    '$box=New-Object System.Windows.Forms.TextBox',
    '$box.Location=New-Object System.Drawing.Point(20,25)',
    '$box.Size=New-Object System.Drawing.Size(250,28)',
    "$box.Text='PRIVATE-TEST-TEXT-NOT-TO-EXPOSE'",
    '$w.Controls.Add($box)',
    '$button=New-Object System.Windows.Forms.Button',
    '$button.Location=New-Object System.Drawing.Point(20,65)',
    '$button.Size=New-Object System.Drawing.Size(160,28)',
    "$button.Text='Do not click'",
    '$w.Controls.Add($button)',
    '[System.Windows.Forms.Application]::Run($w)',
  ].join('\n'),'utf8');
  const started=await desktop('windows.private_desktop.start',{create_shortcut:false}) as {
    data:{running:boolean;inputDesktop:string};
  };
  assert.equal(started.data.running,true);
  assert.equal(started.data.inputDesktop,'Default');
  const launch=await desktop('windows.private_desktop.launch',{
    executable:'powershell.exe',
    args:['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-STA','-File',script],
  }) as {data:{pid:number}};
  let hwnd:string|undefined;
  for(let i=0;i<48;i++){
    const windows=await desktop('windows.private_desktop.windows',{}) as {
      data:{windows:Array<{title:string;hwnd:string}>;inputDesktop:string};
    };
    assert.equal(windows.data.inputDesktop,'Default');
    hwnd=windows.data.windows.find(x=>x.title==='Nx Private Controls Inventory')?.hwnd;
    if(hwnd)break;
    await new Promise(resolve=>setTimeout(resolve,125));
  }
  assert.ok(hwnd,'Expected native form on NexowirePrivate');
  await assert.rejects(desktop('windows.private_desktop.controls',{hwnd:'0x1'}),
    /WINDOW_NOT_PRIVATE_DESKTOP/);
  const result=await desktop('windows.private_desktop.controls',{hwnd}) as {
    data:{
      hwnd:string;processId:number;inputDesktop:string;
      controls:Array<{
        hwnd:string;className:string;processId:number;
        visible:boolean;enabled:boolean;
        rect:{left:number;top:number;width:number;height:number};
      }>;
      truncated:boolean;foreignProcessControlsSkipped:number;
      textContentReturned:boolean;visibleDesktopChanged:boolean;
      boundsRelativeTo:string;
    };
  };
  const scan=result.data;
  assert.equal(scan.processId,launch.data.pid);
  assert.equal(scan.inputDesktop,'Default');
  assert.equal(scan.visibleDesktopChanged,false);
  assert.equal(scan.textContentReturned,false);
  assert.equal(scan.boundsRelativeTo,'TOP_LEVEL_CLIENT');
  assert.equal(scan.truncated,false);
  assert.equal(scan.foreignProcessControlsSkipped,0);
  assert.ok(scan.controls.length>=2);
  assert.ok(scan.controls.length<=128);
  assert.ok(scan.controls.every(x=>x.processId===launch.data.pid));
  assert.ok(scan.controls.some(x=>x.className.toLowerCase().includes('edit')&&
    x.rect.left>=10&&x.rect.left<=40&&x.rect.top>=15&&x.rect.top<=45));
  assert.ok(scan.controls.some(x=>x.className.toLowerCase().includes('button')));
  assert.equal(JSON.stringify(scan).includes('PRIVATE-TEST-TEXT-NOT-TO-EXPOSE'),false);
  const status=await desktop('windows.private_desktop.status',{}) as {
    data:{inputDesktop:string;running:boolean};
  };
  assert.equal(status.data.inputDesktop,'Default');
  assert.equal(status.data.running,true);
});
