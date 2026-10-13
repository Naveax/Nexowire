import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';

test('vertical and horizontal private wheel reach the same-process child control, not the parent',{
  skip:process.platform!=='win32',timeout:95_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-child-wheel-'));
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
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:125});
  });
  const script=path.join(root,'wheel-child-fixture.ps1');
  const events=path.join(root,'wheel-child-events.log');
  await fs.writeFile(script,[
    'param([string]$LogFile)',
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    "$source=@'",
    'using System;',
    'using System.IO;',
    'using System.Drawing;',
    'using System.Windows.Forms;',
    'public sealed class NxWheelChild : Panel {',
    '  private readonly string log;',
    '  public NxWheelChild(string file) {log=file;BackColor=Color.Beige;}',
    '  protected override void WndProc(ref Message m){',
    '    if(m.Msg==0x020A || m.Msg==0x020E){',
    '      int delta=(short)((m.WParam.ToInt64()>>16)&0xffff);',
    '      File.AppendAllText(log,"CHILD:"+m.Msg.ToString("X")+":"+delta+"\\n");',
    '    }',
    '    base.WndProc(ref m);',
    '  }',
    '}',
    'public sealed class NxWheelParent : Form {',
    '  private readonly string log;',
    '  public NxWheelParent(string file) {',
    '    log=file;Text="Nexowire Private Child Wheel Fixture";',
    '    ClientSize=new Size(520,320);',
    '    var child=new NxWheelChild(file);',
    '    child.Location=new Point(20,20);child.Size=new Size(240,160);',
    '    Controls.Add(child);',
    '  }',
    '  protected override void WndProc(ref Message m){',
    '    if(m.Msg==0x020A || m.Msg==0x020E){',
    '      File.AppendAllText(log,"PARENT:"+m.Msg.ToString("X")+"\\n");',
    '    }',
    '    base.WndProc(ref m);',
    '  }',
    '}',
    "'@",
    'Add-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms,System.Drawing',
    '$form=New-Object NxWheelParent($LogFile)',
    '[System.Windows.Forms.Application]::Run($form)',
  ].join('\n'),'utf8');
  const started=await desktop('windows.private_desktop.start',{
    create_shortcut:false,
  }) as {data:{inputDesktop:string;running:boolean}};
  assert.equal(started.data.running,true);
  assert.equal(started.data.inputDesktop,'Default');
  await desktop('windows.private_desktop.launch',{
    executable:'powershell.exe',
    args:['-NoProfile','-NoLogo','-STA','-ExecutionPolicy','Bypass',
      '-File',script,'-LogFile',events],
  });
  let hwnd:string|undefined;
  for(let i=0;i<45;i++){
    const snapshot=await desktop('windows.private_desktop.windows',{}) as {
      data:{inputDesktop:string;windows:Array<{title:string;hwnd:string}>};
    };
    assert.equal(snapshot.data.inputDesktop,'Default');
    hwnd=snapshot.data.windows.find(w=>w.title==='Nexowire Private Child Wheel Fixture')?.hwnd;
    if(hwnd)break;
    await new Promise(resolve=>setTimeout(resolve,140));
  }
  assert.ok(hwnd,'Expected managed private window');
  for(const input of [
    {hwnd,x:80,y:90,delta:120,axis:'vertical'},
    {hwnd,x:80,y:90,delta:-240,axis:'horizontal'},
  ] as const){
    const response=await desktop('windows.private_pointer.scroll',input) as {
      data:{inputDesktop:string;touchesSystemCursor:boolean;visibleDesktopChanged:boolean};
    };
    assert.equal(response.data.inputDesktop,'Default');
    assert.equal(response.data.visibleDesktopChanged,false);
    assert.equal(response.data.touchesSystemCursor,false);
  }
  let written='';
  for(let attempt=0;attempt<30;attempt++){
    written=await fs.readFile(events,'utf8').catch(()=>'');
    if(written.includes('CHILD:20A:120')&&
      written.includes('CHILD:20E:-240'))break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  const eventsReceived=written.split(/\r?\n/).filter(Boolean);
  assert.equal(eventsReceived.filter(x=>x==='CHILD:20A:120').length,1);
  assert.equal(eventsReceived.filter(x=>x==='CHILD:20E:-240').length,1);
  // WinForms may bubble messages from Panel.WndProc to Form.WndProc.
  // The child must receive each event first; parent forwarding is normal.
  assert.equal(eventsReceived[0],'CHILD:20A:120');
  const horizontalIndex=eventsReceived.indexOf('CHILD:20E:-240');
  assert.ok(horizontalIndex>0);
  const parentVerticalIndex=eventsReceived.indexOf('PARENT:20A');
  if(parentVerticalIndex>=0)assert.ok(parentVerticalIndex>0);
  const parentHorizontalIndex=eventsReceived.indexOf('PARENT:20E');
  if(parentHorizontalIndex>=0)assert.ok(parentHorizontalIndex>horizontalIndex);
});
