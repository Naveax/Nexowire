import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ZodError} from 'zod';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';

test('native exact child HWND typing rejects stale/cross-parent/incorrect-class targets',{
  skip:process.platform!=='win32',timeout:105_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-exact-child-'));
  const oldRoot=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const oldSkip=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=root;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await desktop('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(oldRoot===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=oldRoot;
    if(oldSkip===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=oldSkip;
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:150});
  });
  const script=path.join(root,'exact-child-fixture.ps1');
  const firstFile=path.join(root,'first.txt');
  const secondFile=path.join(root,'second.txt');
  await fs.writeFile(script,[
    'param([string]$First,[string]$Second)',
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    "$source=@'",
    'using System;',
    'using System.Drawing;',
    'using System.IO;',
    'using System.Windows.Forms;',
    'public sealed class NxExactChildTextForm : Form {',
    '  public NxExactChildTextForm(string first,string second){',
    '    Text="Nexowire Private Exact Child Text Fixture";',
    '    ClientSize=new Size(520,260);',
    '    var a=new TextBox();a.Location=new Point(20,20);',
    '    a.Size=new Size(300,25);',
    '    a.TextChanged+=(s,e)=>File.WriteAllText(first,a.Text);',
    '    Controls.Add(a);',
    '    var b=new TextBox();b.Location=new Point(20,90);',
    '    b.Size=new Size(300,25);',
    '    b.TextChanged+=(s,e)=>File.WriteAllText(second,b.Text);',
    '    Controls.Add(b);',
    '  }',
    '}',
    "'@",
    'Add-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms,System.Drawing',
    '$form=New-Object NxExactChildTextForm($First,$Second)',
    '[System.Windows.Forms.Application]::Run($form)',
  ].join('\n'),'utf8');
  const started=await desktop('windows.private_desktop.start',{create_shortcut:false}) as {
    data:{running:boolean;inputDesktop:string};
  };
  assert.equal(started.data.running,true);
  assert.equal(started.data.inputDesktop,'Default');
  const launched=await desktop('windows.private_desktop.launch',{
    executable:'powershell.exe',
    args:['-NoLogo','-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',script,
      '-First',firstFile,'-Second',secondFile],
  }) as {data:{pid:number}};
  let hwnd:string|undefined;
  for(let i=0;i<45;i++){
    const inventory=await desktop('windows.private_desktop.windows',{}) as {
      data:{inputDesktop:string;windows:Array<{title:string;hwnd:string}>};
    };
    assert.equal(inventory.data.inputDesktop,'Default');
    hwnd=inventory.data.windows.find(w=>
      w.title==='Nexowire Private Exact Child Text Fixture')?.hwnd;
    if(hwnd)break;
    await new Promise(resolve=>setTimeout(resolve,125));
  }
  assert.ok(hwnd,'expected private fixture window');
  const result=await desktop('windows.private_desktop.controls',{hwnd}) as {
    data:{processId:number;controls:Array<{
      hwnd:string;className:string;processId:number;
      rect:{left:number;top:number;width:number;height:number};
    }>};
  };
  assert.equal(result.data.processId,launched.data.pid);
  const edits=result.data.controls.filter(c=>
    c.className.toLowerCase().includes('edit')).sort((a,b)=>a.rect.top-b.rect.top);
  assert.equal(edits.length,2,'expected two native WinForms TextBox HWNDs');
  assert.ok(edits.every(e=>e.processId===launched.data.pid));
  const second=edits[1];
  if(!second)throw new Error('Second private child text control unavailable');
  const send={hwnd,text:'TARGET-ONLY-2',control_hwnd:second.hwnd,
    expected_class:second.className};
  await assert.rejects(
    desktop('windows.private_keyboard.type',{hwnd,text:'BAD',control_hwnd:second.hwnd}),
    ZodError);
  await assert.rejects(
    desktop('windows.private_keyboard.type',{...send,x:25,y:95}),
    ZodError);
  for(const entry of [
    {...send,control_hwnd:hwnd},
    {...send,control_hwnd:'0x1'},
  ]){
    await assert.rejects(
      desktop('windows.private_keyboard.type',entry),
      (error:unknown)=>error instanceof Error&&
        'code' in error&&error.code==='PRIVATE_CHILD_CONTROL_INVALID',
    );
  }
  await assert.rejects(
    desktop('windows.private_keyboard.type',{...send,expected_class:'WrongClass'}),
    (error:unknown)=>error instanceof Error&&'code' in error&&
      error.code==='PRIVATE_CHILD_CONTROL_CLASS_MISMATCH');
  const typed=await desktop('windows.private_keyboard.type',send) as {
    data:{charsSent:number;inputDesktop:string;touchesSystemKeyboard:boolean;
      visibleDesktopChanged:boolean};
  };
  assert.equal(typed.data.charsSent,'TARGET-ONLY-2'.length);
  assert.equal(typed.data.inputDesktop,'Default');
  assert.equal(typed.data.touchesSystemKeyboard,false);
  assert.equal(typed.data.visibleDesktopChanged,false);
  let secondText='';
  for(let i=0;i<40;i++){
    secondText=await fs.readFile(secondFile,'utf8').catch(()=>'');
    if(secondText==='TARGET-ONLY-2')break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(secondText,'TARGET-ONLY-2');
  assert.equal(await fs.readFile(firstFile,'utf8').catch(()=>''),'');
  const finalState=await desktop('windows.private_desktop.status',{}) as {
    data:{inputDesktop:string};
  };
  assert.equal(finalState.data.inputDesktop,'Default');
});
