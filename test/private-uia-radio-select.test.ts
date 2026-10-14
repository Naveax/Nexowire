import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isReadOnlyCapability} from '../src/protocol/capabilities.js';
import {MCP_TOOL_CAPABILITY_REQUIREMENTS} from '../src/mcp/tool-capabilities.js';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';

test('private radio selection is mutating and mapped to MCP',()=>{
  assert.equal(isReadOnlyCapability('windows.private_desktop.accessibility.select_radio'),false);
  assert.equal(MCP_TOOL_CAPABILITY_REQUIREMENTS.windows_private_desktop_accessibility_select_radio,
    'windows.private_desktop.accessibility.select_radio');
});

test('private WPF RadioButton selects a unique option idempotently with no host focus',{
  skip:process.platform!=='win32',timeout:110_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-uia-radio-'));
  const oldRoot=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const oldShortcut=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=root;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await desktop('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(oldRoot===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=oldRoot;
    if(oldShortcut===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=oldShortcut;
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:150});
  });
  const marker=path.join(root,'selection.txt');
  const fixture=path.join(root,'fixture.ps1');
  await fs.writeFile(fixture,[
    'param([string]$Marker)',
    '$script:marker=$Marker',
    '$script:changed=0',
    'Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase',
    '$w=New-Object Windows.Window',
    "$w.Title='Nx Private UIA Radio Fixture'",
    '$w.Width=500;$w.Height=330',
    '$stack=New-Object Windows.Controls.StackPanel',
    '$w.Content=$stack',
    '$a=New-Object Windows.Controls.RadioButton',
    "$a.Content='First choice'",
    "$a.GroupName='nxGroup'",
    '$a.IsChecked=$true',
    '[System.Windows.Automation.AutomationProperties]::SetAutomationId($a,"nxFirstRadio")',
    "$a.Add_Checked({$script:changed++;[IO.File]::WriteAllText($script:marker,(($script:changed).ToString()+':first'))})",
    '[void]$stack.Children.Add($a)',
    '$b=New-Object Windows.Controls.RadioButton',
    "$b.Content='Second choice'",
    "$b.GroupName='nxGroup'",
    '[System.Windows.Automation.AutomationProperties]::SetAutomationId($b,"nxSecondRadio")',
    "$b.Add_Checked({$script:changed++;[IO.File]::WriteAllText($script:marker,(($script:changed).ToString()+':second'))})",
    '[void]$stack.Children.Add($b)',
    '$disabled=New-Object Windows.Controls.RadioButton',
    '$disabled.IsEnabled=$false',
    '[System.Windows.Automation.AutomationProperties]::SetAutomationId($disabled,"nxDisabledRadio")',
    '[void]$stack.Children.Add($disabled)',
    '$dup1=New-Object Windows.Controls.RadioButton',
    '[System.Windows.Automation.AutomationProperties]::SetAutomationId($dup1,"nxDuplicatedRadio")',
    '[void]$stack.Children.Add($dup1)',
    '$dup2=New-Object Windows.Controls.RadioButton',
    '[System.Windows.Automation.AutomationProperties]::SetAutomationId($dup2,"nxDuplicatedRadio")',
    '[void]$stack.Children.Add($dup2)',
    '$notRadio=New-Object Windows.Controls.Button',
    '[System.Windows.Automation.AutomationProperties]::SetAutomationId($notRadio,"nxNotRadio")',
    '[void]$stack.Children.Add($notRadio)',
    '[void]$w.ShowDialog()',
  ].join('\n'),'utf8');
  const started=await desktop('windows.private_desktop.start',{create_shortcut:false})as{
    data:{running:boolean;inputDesktop:string}};
  assert.equal(started.data.running,true);
  assert.equal(started.data.inputDesktop,'Default');
  const launched=await desktop('windows.private_desktop.launch',{
    executable:'powershell.exe',
    args:['-NoLogo','-NoProfile','-STA','-ExecutionPolicy','Bypass',
      '-File',fixture,'-Marker',marker],
  })as{data:{pid:number}};
  let hwnd:string|undefined;
  for(let i=0;i<45;i++){
    const snapshot=await desktop('windows.private_desktop.windows',{})as{
      data:{inputDesktop:string;windows:Array<{hwnd:string;title:string}>}};
    assert.equal(snapshot.data.inputDesktop,'Default');
    hwnd=snapshot.data.windows.find(w=>w.title==='Nx Private UIA Radio Fixture')?.hwnd;
    if(hwnd)break;
    await new Promise(r=>setTimeout(r,135));
  }
  assert.ok(hwnd,'expected verified private WPF radio fixture');
  const tree=await desktop('windows.private_desktop.accessibility',{hwnd})as{
    data:{nodes:Array<{automationId:string;className:string;controlType:string}>}};
  const byId=(id:string)=>tree.data.nodes.find(n=>n.automationId===id);
  const first=byId('nxFirstRadio');
  const second=byId('nxSecondRadio');
  const disabled=byId('nxDisabledRadio');
  const notRadio=byId('nxNotRadio');
  assert.ok(first&&second&&disabled&&notRadio);
  assert.equal(second.controlType,'ControlType.RadioButton');
  const req={hwnd,automation_id:'nxSecondRadio',expected_class:second.className};
  const readMarker=async()=>await fs.readFile(marker,'utf8').catch(()=>'');
  for(const rejected of [
    {...req,hwnd:'0x1'},
    {...req,automation_id:'no-such-radio'},
    {...req,expected_class:'IncorrectClass'},
    {...req,automation_id:'nxDisabledRadio',expected_class:disabled.className},
    {...req,automation_id:'nxDuplicatedRadio',expected_class:second.className},
    {...req,automation_id:'nxNotRadio',expected_class:notRadio.className},
  ]){
    await assert.rejects(desktop('windows.private_desktop.accessibility.select_radio',rejected));
    assert.equal(await readMarker(),'');
  }
  const result=await desktop('windows.private_desktop.accessibility.select_radio',req)as{
    data:{selected:boolean;processId:number;actionCompleted:boolean;inputDesktop:string;
      touchesSystemCursor:boolean;touchesSystemKeyboard:boolean;
      visibleDesktopChanged:boolean;systemClipboardTouched:boolean}};
  assert.equal(result.data.selected,true);
  assert.equal(result.data.actionCompleted,true);
  assert.equal(result.data.processId,launched.data.pid);
  assert.equal(result.data.inputDesktop,'Default');
  assert.equal(result.data.touchesSystemCursor,false);
  assert.equal(result.data.touchesSystemKeyboard,false);
  assert.equal(result.data.visibleDesktopChanged,false);
  assert.equal(result.data.systemClipboardTouched,false);
  let value='';
  for(let i=0;i<30;i++){
    value=await readMarker();
    if(value==='1:second')break;
    await new Promise(r=>setTimeout(r,100));
  }
  assert.equal(value,'1:second');
  await desktop('windows.private_desktop.accessibility.select_radio',req);
  assert.equal(await readMarker(),'1:second','reselecting selected radio must be a no-op');
  const prev=await desktop('windows.private_desktop.accessibility.select_radio',{
    hwnd,automation_id:'nxFirstRadio',expected_class:first.className,
  })as{data:{inputDesktop:string;selected:boolean}};
  assert.equal(prev.data.inputDesktop,'Default');
  assert.equal(prev.data.selected,true);
  for(let i=0;i<30;i++){
    value=await readMarker();
    if(value==='2:first')break;
    await new Promise(r=>setTimeout(r,100));
  }
  assert.equal(value,'2:first');
});
