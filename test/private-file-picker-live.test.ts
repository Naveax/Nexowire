import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';
import {createPrivateFilePickerAdapter} from '../src/agent/windows-private-file-picker.js';

test('live isolated WPF file picker adapter selects without physical desktop input',{
  skip:process.platform!=='win32',timeout:100_000,
},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-picker-private-'));
  const prevRoot=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const prevShortcut=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=root;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await desktop('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(prevRoot===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=prevRoot;
    if(prevShortcut===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=prevShortcut;
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  });

  const resultFile=path.join(root,'chosen-path.txt');
  const quote=(s:string)=>s.replaceAll("'","''");
  const scriptFile=path.join(root,'picker-fixture.ps1');
  await fs.writeFile(scriptFile,[
    '$ErrorActionPreference="Stop"',
    'Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase',
    '$w=New-Object Windows.Window',
    "$w.Title='Nexowire Private Picker Acceptance'",
    '$w.Width=550;$w.Height=240',
    '$panel=New-Object Windows.Controls.StackPanel',
    '$panel.Margin=20',
    '$edit=New-Object Windows.Controls.TextBox',
    '[System.Windows.Automation.AutomationProperties]::SetAutomationId($edit,"NxFilename")',
    '$edit.Height=34',
    '[void]$panel.Children.Add($edit)',
    '$button=New-Object Windows.Controls.Button',
    '$button.Content="Confirm"',
    '[System.Windows.Automation.AutomationProperties]::SetAutomationId($button,"NxConfirm")',
    '$button.Height=34',
    '$script:pickerEdit=$edit',
    "$button.Add_Click({[System.IO.File]::WriteAllText('"+quote(resultFile)+"',[string]$script:pickerEdit.Text)})",
    '[void]$panel.Children.Add($button)',
    '$w.Content=$panel',
    '[void]$w.ShowDialog()',
  ].join('\n'),'utf8');
  const starting=await desktop('windows.private_desktop.start',{create_shortcut:false}) as{
    data:{running:boolean;inputDesktop:string};
  };
  assert.equal(starting.data.running,true);
  assert.equal(starting.data.inputDesktop,'Default');

  const launched=await desktop('windows.private_desktop.launch',{
    executable:'powershell.exe',
    args:['-NoProfile','-NoLogo','-STA','-ExecutionPolicy','Bypass','-File',scriptFile],
  }) as {data:{pid:number}};
  let hwnd:string|undefined;
  for(let i=0;i<45;i++){
    const list=await desktop('windows.private_desktop.windows',{}) as{
      data:{inputDesktop:string;windows:Array<{hwnd:string;title:string;processId:number}>};
    };
    assert.equal(list.data.inputDesktop,'Default');
    const candidate=list.data.windows.find(w=>w.title==='Nexowire Private Picker Acceptance');
    if(candidate){assert.equal(candidate.processId,launched.data.pid);hwnd=candidate.hwnd;break;}
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  assert.ok(hwnd,'Expected only private desktop fixture window');
  const scan=await desktop('windows.private_desktop.accessibility',{hwnd}) as{
    data:{hwnd:string;processId:number;sessionId:number;inputDesktop:string;
      nodes:Array<{automationId:string;className:string;controlType:string}>};
  };
  assert.equal(scan.data.processId,launched.data.pid);
  assert.equal(scan.data.inputDesktop,'Default');
  assert.ok(scan.data.sessionId>=0);
  const edit=scan.data.nodes.find(n=>n.automationId==='NxFilename'&&
    n.controlType==='ControlType.Edit');
  const button=scan.data.nodes.find(n=>n.automationId==='NxConfirm'&&
    n.controlType==='ControlType.Button');
  assert.ok(edit);assert.ok(button);
  const status=await desktop('windows.private_desktop.status',{}) as{
    data:{startedAt:string;inputDesktop:string};
  };
  const adapter=createPrivateFilePickerAdapter();
  const prepared=await adapter.prepare({
    hwnd,expected_process_id:launched.data.pid,
    expected_session_id:scan.data.sessionId,
    expected_desktop_started_at:status.data.startedAt,
    filename_edit:{automation_id:'NxFilename',expected_class:edit.className},
    confirm_button:{automation_id:'NxConfirm',expected_class:button.className},
  });
  const pathValue=path.win32.join(root,'selected-fixture.txt');
  const selected=await adapter.select({
    grant_id:prepared.data.grantId,path:pathValue,
  });
  assert.equal(selected.data.submitted,true);
  assert.equal(selected.data.selectionVerified,false);
  let observed:string|undefined;
  for(let i=0;i<30;i++){
    observed=await fs.readFile(resultFile,'utf8').catch(()=>undefined);
    if(observed!==undefined)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(observed,pathValue,'WPF button received UIA edit value');
  const after=await desktop('windows.private_desktop.status',{}) as{
    data:{inputDesktop:string};
  };
  assert.equal(after.data.inputDesktop,'Default');
});
