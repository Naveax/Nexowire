import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MCP_TOOL_CAPABILITY_REQUIREMENTS} from '../src/mcp/tool-capabilities.js';
import {isReadOnlyCapability} from '../src/protocol/capabilities.js';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';
import {resolveObservedPrivateUiaTarget} from '../src/agent/windows-private-uia-target.js';

test('UI Automation private subtree inventory is read-only and exposed in MCP',()=>{
  assert.equal(isReadOnlyCapability('windows.private_desktop.accessibility'),true);
  assert.equal(MCP_TOOL_CAPABILITY_REQUIREMENTS.windows_private_desktop_accessibility,
    'windows.private_desktop.accessibility');
});

test('UI Automation sees bounded WPF semantic controls but not secret text',{
  skip:process.platform!=='win32',timeout:110_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-uia-'));
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
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:150});
  });
  const script=path.join(root,'semantic-wpf-fixture.ps1');
  await fs.writeFile(script,[
    'Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase',
    '$window=New-Object Windows.Window',
    "$window.Title='Nexowire Private UIA WPF Fixture'",
    '$window.Width=580;$window.Height=360',
    '$stack=New-Object Windows.Controls.StackPanel',
    '$window.Content=$stack',
    '$button=New-Object Windows.Controls.Button',
    "$button.Content='Semantic Action Button'",
    '$button.Height=35',
    '[System.Windows.Automation.AutomationProperties]::SetAutomationId($button,"nxSemanticButton")',
    '[void]$stack.Children.Add($button)',
    '$textbox=New-Object Windows.Controls.TextBox',
    "$textbox.Text='NX_SUPER_SECRET_WPF_CONTENT_NOT_EXPOSED'",
    '[System.Windows.Automation.AutomationProperties]::SetAutomationId($textbox,"nxPrivateEdit")',
    '[void]$stack.Children.Add($textbox)',
    '[void]$window.ShowDialog()',
  ].join('\n'),'utf8');
  const start=await desktop('windows.private_desktop.start',{create_shortcut:false}) as {
    data:{running:boolean;inputDesktop:string};
  };
  assert.equal(start.data.running,true);
  assert.equal(start.data.inputDesktop,'Default');
  const launched=await desktop('windows.private_desktop.launch',{
    executable:'powershell.exe',
    args:['-NoLogo','-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',script],
  }) as {data:{pid:number}};
  let hwnd:string|undefined;
  for(let i=0;i<50;i++){
    const windows=await desktop('windows.private_desktop.windows',{}) as {
      data:{inputDesktop:string;windows:Array<{title:string;hwnd:string}>};
    };
    assert.equal(windows.data.inputDesktop,'Default');
    hwnd=windows.data.windows.find(w=>w.title==='Nexowire Private UIA WPF Fixture')?.hwnd;
    if(hwnd)break;
    await new Promise(resolve=>setTimeout(resolve,120));
  }
  assert.ok(hwnd,'Expected WPF fixture on private desktop');
  await assert.rejects(desktop('windows.private_desktop.accessibility',{hwnd:'0x1'}),
    /WINDOW_NOT_PRIVATE_DESKTOP/);
  const result=await desktop('windows.private_desktop.accessibility',{hwnd}) as {
    data:{processId:number;inputDesktop:string;visited:number;truncated:boolean;
      nodes:Array<{processId:number;depth:number;controlType:string;
        automationId:string;actionLabel:string;enabled:boolean;
        rect:{left:number;top:number;width:number;height:number}|null}>;
      exposesTextValues:boolean;physicalDesktopInspected:boolean;visibleDesktopChanged:boolean;
      observationScope:string;accessibilityCoverageComplete:boolean};
  };
  assert.equal(result.data.processId,launched.data.pid);
  assert.equal(result.data.inputDesktop,'Default');
  assert.ok(result.data.visited>0);
  assert.ok(result.data.nodes.length>0);
  assert.ok(result.data.nodes.length<=128);
  assert.ok(result.data.nodes.every(n=>n.processId===launched.data.pid));
  assert.ok(result.data.nodes.some(n=>n.controlType.includes('Button')&&
    n.automationId==='nxSemanticButton'&&n.actionLabel==='Semantic Action Button'));
  assert.ok(result.data.nodes.some(n=>n.controlType.includes('Edit')&&
    n.automationId==='nxPrivateEdit'&&n.actionLabel===''));
  assert.equal(JSON.stringify(result).includes('NX_SUPER_SECRET_WPF_CONTENT_NOT_EXPOSED'),false);
  assert.equal(result.data.exposesTextValues,false);
  assert.equal(result.data.physicalDesktopInspected,false);
  assert.equal(result.data.visibleDesktopChanged,false);
  assert.equal(result.data.accessibilityCoverageComplete,false);
  assert.equal(result.data.observationScope,'PRIVATE_WINDOW_UIA_CONTROL_VIEW');
  const selection=await resolveObservedPrivateUiaTarget({
    hwnd,automation_id:'nxSemanticButton',
    control_type:'ControlType.Button',
  });
  assert.equal(selection.data.target.automationId,'nxSemanticButton');
  assert.equal(selection.data.target.controlType,'ControlType.Button');
  assert.equal(selection.data.authorizesInput,false);
  assert.equal(selection.data.physicalDesktopInspected,false);
  await assert.rejects(resolveObservedPrivateUiaTarget({
    hwnd,automation_id:'nxDoesNotExist',
    control_type:'ControlType.Button',
  }),(error:unknown)=>error instanceof Error&&'code'in error&&
    error.code==='PRIVATE_UIA_TARGET_NOT_FOUND');
  const after=await desktop('windows.private_desktop.status',{}) as {
    data:{inputDesktop:string;running:boolean};
  };
  assert.equal(after.data.inputDesktop,'Default');
  assert.equal(after.data.running,true);
});
