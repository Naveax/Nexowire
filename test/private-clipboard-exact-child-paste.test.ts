import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ZodError} from 'zod';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';
import {executeWindowsPrivateClipboardCapability as clip} from '../src/agent/windows-private-clipboard.js';

test('private memory clipboard pastes to exact validated child HWND without using host clipboard',{
  skip:process.platform!=='win32',timeout:100_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-child-text-'));
  const oldRoot=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const oldSkip=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=root;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await clip('windows.private_clipboard.clear',{}).catch(()=>undefined);
    await desktop('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(oldRoot===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=oldRoot;
    if(oldSkip===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=oldSkip;
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:150});
  });
  const script=path.join(root,'child-form.ps1');
  const contentFile=path.join(root,'typed.txt');
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
    'public sealed class NxChildTextFixture : Form {',
    '  private readonly string file;',
    '  private readonly TextBox box;',
    '  public NxChildTextFixture(string destination) {',
    '    file=destination;Text="Nexowire Child Text Fixture";',
    '    ClientSize=new Size(540,300);',
    '    box=new TextBox();box.Location=new Point(20,20);',
    '    box.Size=new Size(290,28);Controls.Add(box);',
    '    box.TextChanged+=(sender,evt)=>File.WriteAllText(file,box.Text);',
    '  }',
    '}',
    "'@",
    'Add-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms,System.Drawing',
    '$form=New-Object NxChildTextFixture($File)',
    '[System.Windows.Forms.Application]::Run($form)',
  ].join('\n'),'utf8');
  const status=await desktop('windows.private_desktop.start',{
    create_shortcut:false,
  }) as {data:{running:boolean;inputDesktop:string}};
  assert.equal(status.data.running,true);
  assert.equal(status.data.inputDesktop,'Default');
  await desktop('windows.private_desktop.launch',{
    executable:'powershell.exe',
    args:['-NoLogo','-NoProfile','-STA','-ExecutionPolicy','Bypass',
      '-File',script,'-File',contentFile],
  });
  let hwnd:string|undefined;
  for(let i=0;i<40;i++){
    const snapshot=await desktop('windows.private_desktop.windows',{}) as {
      data:{inputDesktop:string;windows:Array<{title:string;hwnd:string}>};
    };
    assert.equal(snapshot.data.inputDesktop,'Default');
    hwnd=snapshot.data.windows.find(w=>w.title==='Nexowire Child Text Fixture')?.hwnd;
    if(hwnd)break;
    await new Promise(resolve=>setTimeout(resolve,140));
  }
  assert.ok(hwnd,'Private form must be enumerated');
  const controlResult=await desktop('windows.private_desktop.controls',{hwnd}) as {
    data:{controls:Array<{hwnd:string;className:string;processId:number}>};
  };
  const edit=controlResult.data.controls.find(c=>c.className.toLowerCase().includes('edit'));
  if(!edit)throw new Error('Native TextBox HWND not found');
  await clip('windows.private_clipboard.write',{text:'NX-Clip-43'});
  await assert.rejects(clip('windows.private_clipboard.paste',{
    hwnd,control_hwnd:edit.hwnd,
  }),ZodError);
  await assert.rejects(clip('windows.private_clipboard.paste',{
    hwnd,control_hwnd:edit.hwnd,expected_class:edit.className,x:46,y:32,
  }),ZodError);
  await assert.rejects(clip('windows.private_clipboard.paste',{
    hwnd,control_hwnd:hwnd,expected_class:edit.className,
  }),(error:unknown)=>error instanceof Error&&'code' in error&&
    error.code==='PRIVATE_CHILD_CONTROL_INVALID');
  await assert.rejects(clip('windows.private_clipboard.paste',{
    hwnd,control_hwnd:edit.hwnd,expected_class:'IncorrectClass',
  }),(error:unknown)=>error instanceof Error&&'code' in error&&
    error.code==='PRIVATE_CHILD_CONTROL_CLASS_MISMATCH');
  const response=await clip('windows.private_clipboard.paste',{
    hwnd,control_hwnd:edit.hwnd,expected_class:edit.className,
  }) as {data:{sent:boolean;charsSent:number;inputDesktop:string;physicalClipboardTouched:boolean}};
  assert.equal(response.data.sent,true);
  assert.equal(response.data.charsSent,'NX-Clip-43'.length);
  assert.equal(response.data.inputDesktop,'Default');
  assert.equal(response.data.physicalClipboardTouched,false);

  let actual='';
  for(let attempt=0;attempt<40;attempt++){
    actual=await fs.readFile(contentFile,'utf8').catch(()=>'');
    if(actual==='NX-Clip-43')break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(actual,'NX-Clip-43');
  const after=await desktop('windows.private_desktop.status',{}) as {
    data:{inputDesktop:string;running:boolean};
  };
  assert.equal(after.data.inputDesktop,'Default');
  assert.equal(after.data.running,true);
});
