import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ZodError} from 'zod';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';
import {MCP_TOOL_CAPABILITY_REQUIREMENTS} from '../src/mcp/tool-capabilities.js';
import {isReadOnlyCapability} from '../src/protocol/capabilities.js';

test('private scroll is a mutating capability mapped to an exact MCP tool',()=>{
  assert.equal(isReadOnlyCapability('windows.private_pointer.scroll'),false);
  assert.equal(MCP_TOOL_CAPABILITY_REQUIREMENTS.windows_private_pointer_scroll,
    'windows.private_pointer.scroll');
});

test('actual Windows private HWND accepts WM_MOUSEWHEEL and WM_MOUSEHWHEEL without touching Default',{
  skip:process.platform!=='win32',timeout:80_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-wheel-'));
  const prev=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const prevSkip=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=root;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await desktop('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(prev===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=prev;
    if(prevSkip===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=prevSkip;
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  const script=path.join(root,'fixture.ps1');
  const events=path.join(root,'wheel.log');
  await fs.writeFile(script,[
    'param([string]$LogFile)',
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    "$source=@'",
    'using System;',
    'using System.IO;',
    'using System.Windows.Forms;',
    'public sealed class NxPrivateWheelFixture : Form {',
    '  private readonly string log;',
    '  public NxPrivateWheelFixture(string p) {',
    '    log=p;Text="Nexowire Private Wheel Fixture";',
    '    Width=640;Height=380;',
    '  }',
    '  protected override void WndProc(ref Message m){',
    '    if(m.Msg==0x020A || m.Msg==0x020E){',
    '      int d=(short)((m.WParam.ToInt64()>>16)&0xFFFF);',
    '      File.AppendAllText(log,m.Msg.ToString("X")+":"+d+"\\n");',
    '    }',
    '    base.WndProc(ref m);',
    '  }',
    '}',
    "'@",
    'Add-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms,System.Drawing',
    '$form=New-Object NxPrivateWheelFixture($LogFile)',
    '[System.Windows.Forms.Application]::Run($form)',
  ].join('\n'),'utf8');

  const started=await desktop('windows.private_desktop.start',{
    create_shortcut:false,
  }) as {data:{inputDesktop:string}};
  assert.equal(started.data.inputDesktop,'Default');
  await desktop('windows.private_desktop.launch',{
    executable:'powershell.exe',
    args:['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-STA',
      '-File',script,'-LogFile',events],
  });
  let hwnd:string|undefined;
  for(let i=0;i<45;i++){
    const status=await desktop('windows.private_desktop.windows',{}) as {
      data:{inputDesktop:string;windows:Array<{title:string;hwnd:string}>};
    };
    assert.equal(status.data.inputDesktop,'Default');
    hwnd=status.data.windows.find(w=>w.title==='Nexowire Private Wheel Fixture')?.hwnd;
    if(hwnd)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(hwnd,'Private wheel fixture must have a HWND');
  for(const input of [
    {hwnd,x:40,y:50,delta:120,axis:'vertical'},
    {hwnd,x:40,y:50,delta:-240,axis:'horizontal'},
  ] as const){
    const result=await desktop('windows.private_pointer.scroll',input) as {
      data:{delta:number;axis:string;touchesSystemCursor:boolean;
        visibleDesktopChanged:boolean;inputDesktop:string};
    };
    assert.equal(result.data.inputDesktop,'Default');
    assert.equal(result.data.visibleDesktopChanged,false);
    assert.equal(result.data.touchesSystemCursor,false);
    assert.equal(result.data.delta,input.delta);
    assert.equal(result.data.axis,input.axis);
  }
  for(let i=0;i<20;i++){
    const written=await fs.readFile(events,'utf8').catch(()=>'');
    if(written.includes('20A:120')&&written.includes('20E:-240'))break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  const log=await fs.readFile(events,'utf8');
  assert.match(log,/20A:120/);
  assert.match(log,/20E:-240/);

  await assert.rejects(
    desktop('windows.private_pointer.scroll',{
      hwnd:'0x1',x:40,y:50,delta:120,
    }),
    (err:unknown)=>err instanceof Error&&'code' in err&&
      err.code==='WINDOW_NOT_PRIVATE_DESKTOP',
  );
  await assert.rejects(
    desktop('windows.private_pointer.scroll',{
      hwnd,x:32767,y:32767,delta:120,
    }),
    (err:unknown)=>err instanceof Error&&'code' in err&&
      err.code==='POINT_OUTSIDE_CLIENT',
  );
  for(const delta of [0,1,61,1201,-1201]){
    await assert.rejects(
      desktop('windows.private_pointer.scroll',{
        hwnd,x:40,y:50,delta,
      }),ZodError);
  }
});

test('native code never performs a physical cursor move for scroll',async()=>{
  const code=await fs.readFile(
    new URL('../src/agent/windows-private-desktop.ts',import.meta.url),'utf8');
  assert.match(code,/WM_MOUSEWHEEL=0x020A/);
  assert.match(code,/WM_MOUSEHWHEEL=0x020E/);
  assert.match(code,/ClientToScreen\(h,ref point\)/);
  assert.match(code,/PointerScroll\(/);
  assert.doesNotMatch(code,/\bSetCursorPos\b/);
});
