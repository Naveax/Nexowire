import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isReadOnlyCapability} from '../src/protocol/capabilities.js';
import {MCP_TOOL_CAPABILITY_REQUIREMENTS} from '../src/mcp/tool-capabilities.js';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';

test('private UIA SetValue is a mutating capability with MCP mapping',()=>{
  assert.equal(isReadOnlyCapability('windows.private_desktop.accessibility.set_edit_value'),false);
  assert.equal(
    MCP_TOOL_CAPABILITY_REQUIREMENTS.windows_private_desktop_accessibility_set_edit_value,
    'windows.private_desktop.accessibility.set_edit_value',
  );
});

test('SetValue updates only verified private WPF Edit, never password or physical focus',{
  skip:process.platform!=='win32',timeout:100_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-uia-setvalue-'));
  const oldDir=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const oldShortcut=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=root;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await desktop('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(oldDir===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=oldDir;
    if(oldShortcut===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=oldShortcut;
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:150});
  });
  const marker=path.join(root,'value.txt');
  const script=path.join(root,'edit.ps1');
  await fs.writeFile(script,[
    'param([string]$Marker)',
    '$script:marker=$Marker',
    'Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase',
    '$w=New-Object Windows.Window',
    "$w.Title='Nx Private UIA SetValue Fixture'",
    '$w.Width=540;$w.Height=320',
    '$stack=New-Object Windows.Controls.StackPanel',
    '$w.Content=$stack',
    '$edit=New-Object Windows.Controls.TextBox',
    '[System.Windows.Automation.AutomationProperties]::SetAutomationId($edit,"nxEdit")',
    "$edit.Add_TextChanged({[IO.File]::WriteAllText($script:marker,$edit.Text)})",
    '[void]$stack.Children.Add($edit)',
    '$secret=New-Object Windows.Controls.PasswordBox',
    '[System.Windows.Automation.AutomationProperties]::SetAutomationId($secret,"nxPassword")',
    '[void]$stack.Children.Add($secret)',
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
    hwnd=snap.data.windows.find(w=>w.title==='Nx Private UIA SetValue Fixture')?.hwnd;
    if(hwnd)break;
    await new Promise(resolve=>setTimeout(resolve,125));
  }
  assert.ok(hwnd,'Expected WPF form on private desktop');
  const tree=await desktop('windows.private_desktop.accessibility',{hwnd})as{
    data:{nodes:Array<{automationId:string;className:string;controlType:string}>}};
  const edit=tree.data.nodes.find(n=>n.automationId==='nxEdit');
  const secret=tree.data.nodes.find(n=>n.automationId==='nxPassword');
  assert.ok(edit&&edit.controlType==='ControlType.Edit');
  assert.ok(secret);
  const args={hwnd,automation_id:'nxEdit',expected_class:edit.className,
    value:'PRIVATE_WPF_VALUE_19'};
  for(const bad of [
    {...args,hwnd:'0x1'},
    {...args,automation_id:'does-not-exist'},
    {...args,expected_class:'WrongClass'},
    {...args,automation_id:'nxPassword',expected_class:secret.className},
    {...args,value:'a'.repeat(4001)},
  ]){
    await assert.rejects(desktop('windows.private_desktop.accessibility.set_edit_value',bad));
    assert.equal(await fs.readFile(marker,'utf8').catch(()=>''),'');
  }
  const response=await desktop('windows.private_desktop.accessibility.set_edit_value',args)as{
    data:{processId:number;actionCompleted:boolean;inputDesktop:string;
      systemClipboardTouched:boolean;touchesSystemKeyboard:boolean;
      touchesSystemCursor:boolean;visibleDesktopChanged:boolean}};
  assert.equal(response.data.processId,launched.data.pid);
  assert.equal(response.data.actionCompleted,true);
  assert.equal(response.data.inputDesktop,'Default');
  assert.equal(response.data.systemClipboardTouched,false);
  assert.equal(response.data.touchesSystemKeyboard,false);
  assert.equal(response.data.touchesSystemCursor,false);
  assert.equal(response.data.visibleDesktopChanged,false);
  assert.equal(JSON.stringify(response).includes('PRIVATE_WPF_VALUE_19'),false);
  let actual='';
  for(let i=0;i<35;i++){
    actual=await fs.readFile(marker,'utf8').catch(()=>'');
    if(actual==='PRIVATE_WPF_VALUE_19')break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(actual,'PRIVATE_WPF_VALUE_19');
  const after=await desktop('windows.private_desktop.status',{})as{
    data:{running:boolean;inputDesktop:string}};
  assert.equal(after.data.inputDesktop,'Default');
  assert.equal(after.data.running,true);
});
