import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';
import {executeWindowsWindowCapability} from '../src/agent/windows-window-control.js';
import {createPrivateFilePickerAdapter} from '../src/agent/windows-private-file-picker.js';
import {PathPolicy} from '../src/agent/path-policy.js';

test('native WinForms controls remain confined to independent private desktop',{
  skip:process.platform!=='win32',timeout:100_000,
},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-winforms-'));
  const previousRoot=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const previousSkip=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=root;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await desktop('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(previousRoot===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=previousRoot;
    if(previousSkip===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=previousSkip;
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  });
  const marker=path.win32.join(root,'selected.txt');
  const receipt=path.win32.join(root,'receipt.txt');
  await fs.writeFile(marker,'verified local WinForms selection','utf8');
  const quoted=(v:string)=>v.replaceAll("'","''");
  const script=path.join(root,'winforms-native-fixture.ps1');
  await fs.writeFile(script,[
    '$ErrorActionPreference="Stop"',
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    '$form=New-Object System.Windows.Forms.Form',
    "$form.Text='NX_PRIVATE_WINFORMS_PICKER_FIXTURE'",
    '$form.Width=560;$form.Height=220',
    '$form.StartPosition=[System.Windows.Forms.FormStartPosition]::Manual',
    '$form.Left=40;$form.Top=50',
    '$edit=New-Object System.Windows.Forms.TextBox',
    '$edit.Name="NxFilenameWinForms";$edit.Left=20;$edit.Top=25',
    '$edit.Width=480;$edit.Height=26',
    '$button=New-Object System.Windows.Forms.Button',
    '$button.Name="NxConfirmWinForms";$button.Text="Confirm"',
    '$button.Left=20;$button.Top=80;$button.Width=130',
    '$script:filenameBox=$edit',
    "$button.Add_Click({[System.IO.File]::WriteAllText('"+quoted(receipt)+"',[string]$script:filenameBox.Text)})",
    '[void]$form.Controls.Add($edit)',
    '[void]$form.Controls.Add($button)',
    '[void]$form.ShowDialog()',
  ].join('\n'),'utf8');
  const start=await desktop('windows.private_desktop.start',{create_shortcut:false}) as{
    data:{running:boolean;inputDesktop:string};
  };
  assert.equal(start.data.running,true);
  assert.equal(start.data.inputDesktop,'Default');
  const launch=await desktop('windows.private_desktop.launch',{
    executable:'powershell.exe',
    args:['-NoProfile','-NoLogo','-STA','-ExecutionPolicy','Bypass','-File',script],
  }) as {data:{pid:number}};
  let hwnd:string|undefined;
  for(let i=0;i<40;i++){
    const listing=await desktop('windows.private_desktop.windows',{}) as{
      data:{inputDesktop:string;windows:Array<{hwnd:string;title:string;processId:number}>};
    };
    assert.equal(listing.data.inputDesktop,'Default');
    const found=listing.data.windows.find(w=>w.title==='NX_PRIVATE_WINFORMS_PICKER_FIXTURE');
    if(found){hwnd=found.hwnd;assert.equal(found.processId,launch.data.pid);break;}
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  assert.ok(hwnd);
  const defaultListing=await executeWindowsWindowCapability('windows.window.list',{}) as {
    data:{foregroundHwnd:string|null;windows:Array<{hwnd:string;processId:number}>};
  };
  assert.notEqual(defaultListing.data.foregroundHwnd?.toLowerCase(),hwnd.toLowerCase(),
    'Private window must never acquire owner foreground HWND');
  assert.equal(defaultListing.data.windows.some(w=>w.processId===launch.data.pid),false,
    'Private app PID must not show up on the user Default desktop enumeration');
  const scan=await desktop('windows.private_desktop.accessibility',{hwnd}) as{
    data:{hwnd:string;processId:number;sessionId:number;inputDesktop:string;
      nodes:Array<{automationId:string;className:string;controlType:string}>};
  };
  assert.equal(scan.data.processId,launch.data.pid);
  assert.equal(scan.data.inputDesktop,'Default');
  const edit=scan.data.nodes.find(n=>/\.EDIT\./i.test(n.className));
  const button=scan.data.nodes.find(n=>/\.BUTTON\./i.test(n.className));
  assert.ok(edit,'Expected same-PID WinForms EDIT child in private UIA inventory');
  assert.ok(button,'Expected same-PID WinForms BUTTON child in private UIA inventory');
  const status=await desktop('windows.private_desktop.status',{}) as {
    data:{startedAt:string;inputDesktop:string};
  };
  const adapter=createPrivateFilePickerAdapter();
  const binding={
    hwnd,expected_process_id:launch.data.pid,expected_session_id:scan.data.sessionId,
    expected_desktop_started_at:status.data.startedAt,
    filename_edit:{automation_id:edit.automationId,expected_class:edit.className},
    confirm_button:{automation_id:button.automationId,expected_class:button.className},
  };
  if(edit.controlType==='ControlType.Edit'&&
     button.controlType==='ControlType.Button'){
    const permit=await adapter.prepare(binding);
    const policy=new PathPolicy([root]);
    const selected=await adapter.select({grant_id:permit.data.grantId,path:marker},
      requested=>policy.resolveExisting(requested));
    assert.equal(selected.data.submitted,true);
    let actual:string|undefined;
    for(let i=0;i<25;i++){
      actual=await fs.readFile(receipt,'utf8').catch(()=>undefined);
      if(actual!==undefined)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(actual,marker);
  }else{
    // Real WinForms UIA commonly exposes native EDIT/BUTTON as Pane with
    // runtime-generated IDs. Never infer actionability from Win32 class.
    await assert.rejects(adapter.prepare(binding),(error:unknown)=>
      !!error&&typeof error==='object'&&'code'in error&&
      error.code==='PICKER_CONTROL_NOT_UNIQUE');
    assert.equal(await fs.readFile(receipt,'utf8').catch(()=>undefined),undefined,
      'Unsupported native controls must not trigger confirmation');
  }
  const after=await desktop('windows.private_desktop.status',{}) as {
    data:{inputDesktop:string};
  };
  assert.equal(after.data.inputDesktop,'Default');
});
