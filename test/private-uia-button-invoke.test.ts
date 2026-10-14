import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isReadOnlyCapability} from '../src/protocol/capabilities.js';
import {MCP_TOOL_CAPABILITY_REQUIREMENTS} from '../src/mcp/tool-capabilities.js';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';

test('private UIA button invocation is an explicitly mutating capability',()=>{
  assert.equal(isReadOnlyCapability('windows.private_desktop.accessibility.invoke_button'),false);
  assert.equal(MCP_TOOL_CAPABILITY_REQUIREMENTS.windows_private_desktop_accessibility_invoke_button,
    'windows.private_desktop.accessibility.invoke_button');
});

test('only a unique enabled private WPF Button can be invoked with no physical focus',{
  skip:process.platform!=='win32',timeout:105_000,
},async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nx-uia-private-invoke-'));
  const oldRoot=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const oldShortcut=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=dir;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await desktop('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(oldRoot===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=oldRoot;
    if(oldShortcut===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=oldShortcut;
    await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:120});
  });
  const marker=path.join(dir,'clicked.txt');
  const script=path.join(dir,'fixture.ps1');
  await fs.writeFile(script,[
    'param([string]$Marker)',
    '$script:outputFile=$Marker',
    'Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase',
    '$w=New-Object Windows.Window',
    "$w.Title='Nx Private UIA Invoke Fixture'",
    '$w.Width=550;$w.Height=330',
    '$stack=New-Object Windows.Controls.StackPanel',
    '$w.Content=$stack',
    '$button=New-Object Windows.Controls.Button',
    "$button.Content='Invoke Me'",
    '$button.Height=45',
    '[System.Windows.Automation.AutomationProperties]::SetAutomationId($button,"nxOnlyButton")',
    "$button.Add_Click({[System.IO.File]::WriteAllText($script:outputFile,'INVOKED')})",
    '[void]$stack.Children.Add($button)',
    '$edit=New-Object Windows.Controls.TextBox',
    "$edit.Text='NEVER_READ_PRIVATE_TEXT'",
    '[System.Windows.Automation.AutomationProperties]::SetAutomationId($edit,"nxPrivateEdit")',
    '[void]$stack.Children.Add($edit)',
    '[void]$w.ShowDialog()',
  ].join('\n'),'utf8');

  const started=await desktop('windows.private_desktop.start',{create_shortcut:false}) as{
    data:{running:boolean;inputDesktop:string};
  };
  assert.equal(started.data.running,true);
  assert.equal(started.data.inputDesktop,'Default');
  const launched=await desktop('windows.private_desktop.launch',{
    executable:'powershell.exe',
    args:['-NoLogo','-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',
      script,'-Marker',marker],
  })as{data:{pid:number}};
  let hwnd:string|undefined;
  for(let i=0;i<45;i++){
    const windows=await desktop('windows.private_desktop.windows',{}) as{
      data:{inputDesktop:string;windows:Array<{hwnd:string;title:string}>};
    };
    assert.equal(windows.data.inputDesktop,'Default');
    hwnd=windows.data.windows.find(w=>w.title==='Nx Private UIA Invoke Fixture')?.hwnd;
    if(hwnd)break;
    await new Promise(resolve=>setTimeout(resolve,130));
  }
  assert.ok(hwnd,'expected verified private WPF window');
  const tree=await desktop('windows.private_desktop.accessibility',{hwnd}) as{
    data:{nodes:Array<{automationId:string;className:string;controlType:string}>};
  };
  const button=tree.data.nodes.find(n=>n.automationId==='nxOnlyButton');
  assert.ok(button&&button.controlType==='ControlType.Button');
  const args={hwnd,automation_id:'nxOnlyButton',expected_class:button.className};
  for(const bad of [
    {...args,hwnd:'0x1'},
    {...args,automation_id:'missing'},
    {...args,expected_class:'WrongClass'},
    {...args,automation_id:'nxPrivateEdit'},
  ]){
    await assert.rejects(desktop('windows.private_desktop.accessibility.invoke_button',bad));
    assert.equal(await fs.readFile(marker,'utf8').catch(()=>''),'');
  }
  const invoked=await desktop('windows.private_desktop.accessibility.invoke_button',
    args)as{data:{invoked:boolean;inputDesktop:string;processId:number;
      touchesSystemKeyboard:boolean;touchesSystemCursor:boolean;visibleDesktopChanged:boolean}};
  assert.equal(invoked.data.invoked,true);
  assert.equal(invoked.data.processId,launched.data.pid);
  assert.equal(invoked.data.inputDesktop,'Default');
  assert.equal(invoked.data.touchesSystemKeyboard,false);
  assert.equal(invoked.data.touchesSystemCursor,false);
  assert.equal(invoked.data.visibleDesktopChanged,false);
  let result='';
  for(let i=0;i<30;i++){
    result=await fs.readFile(marker,'utf8').catch(()=>'');
    if(result==='INVOKED')break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(result,'INVOKED');
  const after=await desktop('windows.private_desktop.status',{})as{
    data:{inputDesktop:string;running:boolean};
  };
  assert.equal(after.data.inputDesktop,'Default');
  assert.equal(after.data.running,true);
});
