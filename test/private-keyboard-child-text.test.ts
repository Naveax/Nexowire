import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ZodError} from 'zod';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';

test('private keyboard sends WM_CHAR only to a selected same-process child TextBox',{
  skip:process.platform!=='win32',timeout:100_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-child-text-'));
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
  await assert.rejects(desktop('windows.private_keyboard.type',{
    hwnd,text:'bad',x:30,
  }),ZodError);
  await assert.rejects(desktop('windows.private_keyboard.type',{
    hwnd,text:'bad',x:30000,y:30000,
  }), (err:unknown)=>err instanceof Error&&'code' in err&&
    err.code==='POINT_OUTSIDE_CLIENT');

  const response=await desktop('windows.private_keyboard.type',{
    hwnd,text:'NX-Child-42',x:46,y:32,
  }) as {data:{charsSent:number;inputDesktop:string;touchesSystemKeyboard:boolean;
    visibleDesktopChanged:boolean}};
  assert.equal(response.data.charsSent,'NX-Child-42'.length);
  assert.equal(response.data.inputDesktop,'Default');
  assert.equal(response.data.touchesSystemKeyboard,false);
  assert.equal(response.data.visibleDesktopChanged,false);

  let actual='';
  for(let attempt=0;attempt<40;attempt++){
    actual=await fs.readFile(contentFile,'utf8').catch(()=>'');
    if(actual==='NX-Child-42')break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(actual,'NX-Child-42');
  const after=await desktop('windows.private_desktop.status',{}) as {
    data:{inputDesktop:string;running:boolean};
  };
  assert.equal(after.data.inputDesktop,'Default');
  assert.equal(after.data.running,true);
});
