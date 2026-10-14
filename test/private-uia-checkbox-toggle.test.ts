import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isReadOnlyCapability} from '../src/protocol/capabilities.js';
import {MCP_TOOL_CAPABILITY_REQUIREMENTS} from '../src/mcp/tool-capabilities.js';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';

test('private checkbox SetChecked is explicitly mutating',()=>{
  assert.equal(isReadOnlyCapability('windows.private_desktop.accessibility.set_checkbox'),false);
  assert.equal(MCP_TOOL_CAPABILITY_REQUIREMENTS.windows_private_desktop_accessibility_set_checkbox,
    'windows.private_desktop.accessibility.set_checkbox');
});

test('verified private UIA CheckBox sets requested state once without physical focus',{
  skip:process.platform!=='win32',timeout:110_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-uia-checkbox-'));
  const beforeRoot=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const beforeShortcut=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=root;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await desktop('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(beforeRoot===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=beforeRoot;
    if(beforeShortcut===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=beforeShortcut;
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:150});
  });
  const marker=path.join(root,'changed.txt');
  const script=path.join(root,'fixture.ps1');
  await fs.writeFile(script,[
    'param([string]$Marker)',
    '$script:marker=$Marker',
    '$script:changes=0',
    'Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase',
    '$w=New-Object Windows.Window',
    "$w.Title='Nx Private UIA Checkbox Fixture'",
    '$w.Width=540;$w.Height=320',
    '$stack=New-Object Windows.Controls.StackPanel',
    '$w.Content=$stack',
    '$check=New-Object Windows.Controls.CheckBox',
    "$check.Content='Explicit opt in'",
    '$check.IsChecked=$false',
    '[System.Windows.Automation.AutomationProperties]::SetAutomationId($check,"nxOnlyCheck")',
    "$check.Add_Checked({$script:changes++;[IO.File]::WriteAllText($script:marker,(($script:changes).ToString()+':true'))})",
    "$check.Add_Unchecked({$script:changes++;[IO.File]::WriteAllText($script:marker,(($script:changes).ToString()+':false'))})",
    '[void]$stack.Children.Add($check)',
    '$button=New-Object Windows.Controls.Button',
    "$button.Content='Do not invoke'",
    '[System.Windows.Automation.AutomationProperties]::SetAutomationId($button,"nxNotACheckbox")',
    '[void]$stack.Children.Add($button)',
    '$disabled=New-Object Windows.Controls.CheckBox',
    '$disabled.IsEnabled=$false',
    '[System.Windows.Automation.AutomationProperties]::SetAutomationId($disabled,"nxDisabledCheck")',
    '[void]$stack.Children.Add($disabled)',
    '$mixed=New-Object Windows.Controls.CheckBox',
    '$mixed.IsThreeState=$true',
    '$mixed.IsChecked=$null',
    '[System.Windows.Automation.AutomationProperties]::SetAutomationId($mixed,"nxMixedCheck")',
    '[void]$stack.Children.Add($mixed)',
    '$dupOne=New-Object Windows.Controls.CheckBox',
    '[System.Windows.Automation.AutomationProperties]::SetAutomationId($dupOne,"nxDuplicateCheck")',
    '[void]$stack.Children.Add($dupOne)',
    '$dupTwo=New-Object Windows.Controls.CheckBox',
    '[System.Windows.Automation.AutomationProperties]::SetAutomationId($dupTwo,"nxDuplicateCheck")',
    '[void]$stack.Children.Add($dupTwo)',
    '[void]$w.ShowDialog()',
  ].join('\n'),'utf8');
  const started=await desktop('windows.private_desktop.start',{create_shortcut:false})as{
    data:{running:boolean;inputDesktop:string}};
  assert.equal(started.data.running,true);
  assert.equal(started.data.inputDesktop,'Default');
  const launched=await desktop('windows.private_desktop.launch',{
    executable:'powershell.exe',
    args:['-NoLogo','-NoProfile','-STA','-ExecutionPolicy','Bypass',
      '-File',script,'-Marker',marker],
  })as{data:{pid:number}};
  let hwnd:string|undefined;
  for(let i=0;i<50;i++){
    const snap=await desktop('windows.private_desktop.windows',{})as{
      data:{inputDesktop:string;windows:Array<{title:string;hwnd:string}>}};
    assert.equal(snap.data.inputDesktop,'Default');
    hwnd=snap.data.windows.find(w=>w.title==='Nx Private UIA Checkbox Fixture')?.hwnd;
    if(hwnd)break;
    await new Promise(resolve=>setTimeout(resolve,120));
  }
  assert.ok(hwnd,'Expected private checkbox fixture');
  const tree=await desktop('windows.private_desktop.accessibility',{hwnd})as{
    data:{nodes:Array<{automationId:string;className:string;controlType:string}>}};
  const checkbox=tree.data.nodes.find(n=>n.automationId==='nxOnlyCheck');
  const button=tree.data.nodes.find(n=>n.automationId==='nxNotACheckbox');
  const disabled=tree.data.nodes.find(n=>n.automationId==='nxDisabledCheck');
  const mixed=tree.data.nodes.find(n=>n.automationId==='nxMixedCheck');
  assert.ok(disabled&&disabled.controlType==='ControlType.CheckBox');
  assert.ok(mixed&&mixed.controlType==='ControlType.CheckBox');
  assert.ok(checkbox&&checkbox.controlType==='ControlType.CheckBox');
  assert.ok(button&&button.controlType==='ControlType.Button');
  const request={hwnd,automation_id:'nxOnlyCheck',expected_class:checkbox.className,
    checked:true};
  for(const bad of [
    {...request,hwnd:'0x1'},
    {...request,automation_id:'no-such-control'},
    {...request,expected_class:'IncorrectClass'},
    {...request,automation_id:'nxNotACheckbox',expected_class:button.className},
    {...request,automation_id:'nxDisabledCheck',expected_class:disabled.className},
    {...request,automation_id:'nxMixedCheck',expected_class:mixed.className},
    {...request,automation_id:'nxDuplicateCheck',expected_class:checkbox.className},
    {...request,checked:'yes'},
  ]){
    await assert.rejects(desktop('windows.private_desktop.accessibility.set_checkbox',bad));
    assert.equal(await fs.readFile(marker,'utf8').catch(()=>''),
      '');
  }
  const once=await desktop('windows.private_desktop.accessibility.set_checkbox',
    request)as{data:{checked:boolean;actionCompleted:boolean;processId:number;
      inputDesktop:string;touchesSystemCursor:boolean;touchesSystemKeyboard:boolean;
      visibleDesktopChanged:boolean;systemClipboardTouched:boolean}};
  assert.equal(once.data.checked,true);
  assert.equal(once.data.actionCompleted,true);
  assert.equal(once.data.processId,launched.data.pid);
  assert.equal(once.data.inputDesktop,'Default');
  assert.equal(once.data.touchesSystemCursor,false);
  assert.equal(once.data.touchesSystemKeyboard,false);
  assert.equal(once.data.systemClipboardTouched,false);
  assert.equal(once.data.visibleDesktopChanged,false);
  const markerValue=async()=>fs.readFile(marker,'utf8').catch(()=>'');
  let value='';
  for(let i=0;i<30;i++){
    value=await markerValue();
    if(value==='1:true')break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(value,'1:true');
  const repeated=await desktop('windows.private_desktop.accessibility.set_checkbox',
    request)as{data:{checked:boolean}};
  assert.equal(repeated.data.checked,true);
  assert.equal(await markerValue(),'1:true','Idempotent SetChecked must not toggle again');
  const off=await desktop('windows.private_desktop.accessibility.set_checkbox',
    {...request,checked:false})as{data:{checked:boolean;inputDesktop:string}};
  assert.equal(off.data.checked,false);
  for(let i=0;i<30;i++){
    value=await markerValue();
    if(value==='2:false')break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(value,'2:false');
  assert.equal(off.data.inputDesktop,'Default');
});
