import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';

test('exact native child click rejects stale, wrong-class and point-mismatch targets',{
  skip:process.platform!=='win32',timeout:90_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-child-click-'));
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
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:125});
  });
  const script=path.join(root,'click-fixture.ps1');
  const log=path.join(root,'click-events.txt');
  await fs.writeFile(script,[
    'param([string]$File)',
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    "$source=@'",
    'using System;',
    'using System.IO;',
    'using System.Drawing;',
    'using System.Windows.Forms;',
    'public sealed class NxClickChild : Panel {',
    '  readonly string output;',
    '  public NxClickChild(string file){output=file;BackColor=Color.LightBlue;}',
    '  protected override void WndProc(ref Message m){',
    '    if(m.Msg==0x0201||m.Msg==0x0202)',
    '      File.AppendAllText(output,"CHILD:"+m.Msg.ToString("X")+"\\n");',
    '    base.WndProc(ref m);',
    '  }',
    '}',
    'public sealed class NxClickForm : Form {',
    '  readonly string output;',
    '  public NxClickForm(string file){',
    '    output=file;Text="Nx Private Child Click Fixture";',
    '    ClientSize=new Size(540,320);',
    '    var panel=new NxClickChild(file);',
    '    panel.Location=new Point(20,20);panel.Size=new Size(280,170);',
    '    Controls.Add(panel);',
    '  }',
    '  protected override void WndProc(ref Message m){',
    '    if(m.Msg==0x0201||m.Msg==0x0202)',
    '      File.AppendAllText(output,"PARENT:"+m.Msg.ToString("X")+"\\n");',
    '    base.WndProc(ref m);',
    '  }',
    '}',
    "'@",
    'Add-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms,System.Drawing',
    '$form=New-Object NxClickForm($File)',
    '[System.Windows.Forms.Application]::Run($form)',
  ].join('\n'),'utf8');
  const started=await desktop('windows.private_desktop.start',{create_shortcut:false}) as {
    data:{running:boolean;inputDesktop:string};
  };
  assert.equal(started.data.running,true);
  assert.equal(started.data.inputDesktop,'Default');
  await desktop('windows.private_desktop.launch',{
    executable:'powershell.exe',
    args:['-NoProfile','-NoLogo','-STA','-ExecutionPolicy','Bypass',
      '-File',script,'-File',log],
  });
  let hwnd:string|undefined;
  for(let i=0;i<40;i++){
    const inventory=await desktop('windows.private_desktop.windows',{}) as {
      data:{inputDesktop:string;windows:Array<{title:string;hwnd:string}>};
    };
    assert.equal(inventory.data.inputDesktop,'Default');
    hwnd=inventory.data.windows.find(w=>w.title==='Nx Private Child Click Fixture')?.hwnd;
    if(hwnd)break;
    await new Promise(resolve=>setTimeout(resolve,120));
  }
  assert.ok(hwnd,'The private child click fixture must be enumerated');
  const scan=await desktop('windows.private_desktop.controls',{hwnd}) as {
    data:{controls:Array<{hwnd:string;className:string;
      rect:{left:number;top:number;width:number;height:number}}>};
  };
  const child=scan.data.controls.find(c=>c.rect.left>=15&&c.rect.left<35&&c.rect.top>=15&&c.rect.top<35);
  if(!child)throw new Error('Expected private native child panel');
  const exact={control_hwnd:child.hwnd,expected_class:child.className};
  await assert.rejects(
    desktop('windows.private_pointer.click',{hwnd,x:70,y:75,control_hwnd:child.hwnd}),
    /control_hwnd and expected_class/,
  );
  for(const [control_hwnd,expected_class,code] of [
    [hwnd,child.className,'PRIVATE_CHILD_CONTROL_INVALID'],
    ['0x1',child.className,'PRIVATE_CHILD_CONTROL_INVALID'],
    [child.hwnd,'IncorrectClass','PRIVATE_CHILD_CONTROL_CLASS_MISMATCH'],
  ]as const){
    await assert.rejects(desktop('windows.private_pointer.click',{
      hwnd,x:70,y:75,control_hwnd,expected_class,
    }),(err:unknown)=>err instanceof Error&&'code'in err&&err.code===code);
  }
  await assert.rejects(desktop('windows.private_pointer.click',{
    hwnd,x:480,y:240,...exact,
  }),(err:unknown)=>err instanceof Error&&'code' in err&&
    err.code==='PRIVATE_CHILD_CONTROL_POINT_MISMATCH');
  assert.equal(await fs.readFile(log,'utf8').catch(()=>''),'');
  await assert.rejects(desktop('windows.private_pointer.click',{
    hwnd:'0x1',x:50,y:60,button:'left',
  }),(err:unknown)=>err instanceof Error&&
    'code' in err&&err.code==='WINDOW_NOT_PRIVATE_DESKTOP');
  await assert.rejects(desktop('windows.private_pointer.click',{
    hwnd,x:32767,y:32767,button:'left',
  }),(err:unknown)=>err instanceof Error&&
    'code' in err&&err.code==='POINT_OUTSIDE_CLIENT');
  const delivered=await desktop('windows.private_pointer.click',{
    hwnd,x:70,y:75,button:'left',clicks:1,...exact,
  }) as {data:{inputDesktop:string;touchesSystemCursor:boolean;
    visibleDesktopChanged:boolean}};
  assert.equal(delivered.data.inputDesktop,'Default');
  assert.equal(delivered.data.touchesSystemCursor,false);
  assert.equal(delivered.data.visibleDesktopChanged,false);
  let events:string[]=[];
  for(let i=0;i<30;i++){
    events=(await fs.readFile(log,'utf8').catch(()=>'')).split(/\r?\n/).filter(Boolean);
    if(events.includes('CHILD:201')&&events.includes('CHILD:202'))break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(events.filter(x=>x==='CHILD:201').length,1);
  assert.equal(events.filter(x=>x==='CHILD:202').length,1);
  assert.ok(events.indexOf('CHILD:201')<events.indexOf('CHILD:202'));
  const after=await desktop('windows.private_desktop.status',{}) as {
    data:{inputDesktop:string;running:boolean};
  };
  assert.equal(after.data.inputDesktop,'Default');
  assert.equal(after.data.running,true);
});
