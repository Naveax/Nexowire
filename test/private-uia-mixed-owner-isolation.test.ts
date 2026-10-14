import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';

const execFileAsync=promisify(execFile);

// Only observes GetCursorPos and GetForegroundWindow on the DEV host.
// It never sets desktop focus, moves a cursor or posts host GUI input.
async function physicalOwnerSnapshot(){
  const ps=String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NxPhysicalObserver {
  [StructLayout(LayoutKind.Sequential)] public struct Point {public int X; public int Y;}
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  public static string Snapshot() {
    Point p; if(!GetCursorPos(out p))throw new InvalidOperationException("OWNER_CURSOR_UNAVAILABLE");
    return p.X.ToString()+","+p.Y.ToString()+"|"+GetForegroundWindow().ToInt64().ToString();
  }
}
'@
[NxPhysicalObserver]::Snapshot()
`;
  const result=await execFileAsync('powershell.exe',[
    '-NoProfile','-NoLogo','-NonInteractive','-Command',ps,
  ],{windowsHide:true,timeout:15000,maxBuffer:10000});
  return result.stdout.trim();
}

test('private multi-control WPF actions preserve owner cursor and foreground over consecutive cycles',{
  skip:process.platform!=='win32',timeout:180_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-mixed-uia-isolation-'));
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
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:125});
  });
  const script=path.join(root,'private-mixed.ps1');
  await fs.writeFile(script,[
    'param([string]$Dir)',
    '$script:dir=$Dir;$script:clicks=0',
    'Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase',
    '$w=New-Object Windows.Window',
    "$w.Title='Nx Private Mixed Owner Isolation Fixture'",
    '$w.Width=520;$w.Height=340',
    '$stack=New-Object Windows.Controls.StackPanel',
    '$w.Content=$stack',
    '$button=New-Object Windows.Controls.Button',
    "$button.Content='Test only'",
    '[System.Windows.Automation.AutomationProperties]::SetAutomationId($button,"nxOwnerButton")',
    "$button.Add_Click({$script:clicks++;[IO.File]::WriteAllText((Join-Path $script:dir 'button.txt'),[string]$script:clicks)})",
    '[void]$stack.Children.Add($button)',
    '$edit=New-Object Windows.Controls.TextBox',
    '[System.Windows.Automation.AutomationProperties]::SetAutomationId($edit,"nxOwnerEdit")',
    "$edit.Add_TextChanged({[IO.File]::WriteAllText((Join-Path $script:dir 'edit.txt'),$edit.Text)})",
    '[void]$stack.Children.Add($edit)',
    '$check=New-Object Windows.Controls.CheckBox',
    "$check.Content='Test checkbox'",
    '$check.IsChecked=$false',
    '[System.Windows.Automation.AutomationProperties]::SetAutomationId($check,"nxOwnerCheck")',
    "$check.Add_Checked({[IO.File]::WriteAllText((Join-Path $script:dir 'check.txt'),'true')})",
    "$check.Add_Unchecked({[IO.File]::WriteAllText((Join-Path $script:dir 'check.txt'),'false')})",
    '[void]$stack.Children.Add($check)',
    '$radioA=New-Object Windows.Controls.RadioButton',
    '$radioA.GroupName="nxOwnerGroup";$radioA.IsChecked=$true',
    '[System.Windows.Automation.AutomationProperties]::SetAutomationId($radioA,"nxOwnerRadioA")',
    "$radioA.Add_Checked({[IO.File]::WriteAllText((Join-Path $script:dir 'radio.txt'),'a')})",
    '[void]$stack.Children.Add($radioA)',
    '$radioB=New-Object Windows.Controls.RadioButton',
    '$radioB.GroupName="nxOwnerGroup"',
    '[System.Windows.Automation.AutomationProperties]::SetAutomationId($radioB,"nxOwnerRadioB")',
    "$radioB.Add_Checked({[IO.File]::WriteAllText((Join-Path $script:dir 'radio.txt'),'b')})",
    '[void]$stack.Children.Add($radioB)',
    '[void]$w.ShowDialog()',
  ].join('\n'),'utf8');
  const started=await desktop('windows.private_desktop.start',{
    create_shortcut:false,
  })as{data:{running:boolean;inputDesktop:string}};
  assert.equal(started.data.running,true);
  assert.equal(started.data.inputDesktop,'Default');
  const launch=await desktop('windows.private_desktop.launch',{
    executable:'powershell.exe',
    args:['-NoLogo','-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',script,'-Dir',root],
  })as{data:{pid:number}};
  let hwnd:string|undefined;
  for(let i=0;i<50;i++){
    const snapshot=await desktop('windows.private_desktop.windows',{})as{
      data:{inputDesktop:string;windows:Array<{title:string;hwnd:string}>}};
    assert.equal(snapshot.data.inputDesktop,'Default');
    hwnd=snapshot.data.windows.find(w=>
      w.title==='Nx Private Mixed Owner Isolation Fixture')?.hwnd;
    if(hwnd)break;
    await new Promise(resolve=>setTimeout(resolve,120));
  }
  assert.ok(hwnd,'Expected private mixed control fixture');
  const tree=await desktop('windows.private_desktop.accessibility',{hwnd})as{
    data:{inputDesktop:string;nodes:Array<{automationId:string;controlType:string;
      className:string;processId:number}>}};
  assert.equal(tree.data.inputDesktop,'Default');
  const names=['nxOwnerButton','nxOwnerEdit','nxOwnerCheck','nxOwnerRadioA','nxOwnerRadioB'];
  const controls=new Map(tree.data.nodes.map(n=>[n.automationId,n]));
  for(const name of names){
    const found=controls.get(name);
    assert.ok(found,`Private UIA element missing: ${name}`);
    assert.equal(found.processId,launch.data.pid);
  }
  const request=(id:string)=>({
    hwnd,automation_id:id,expected_class:controls.get(id)!.className,
  });
  const read=async(file:string)=>fs.readFile(path.join(root,file),'utf8').catch(()=>'');
  const settle=async(file:string,expected:string)=>{
    for(let i=0;i<35;i++){
      if((await read(file))===expected)return;
      await new Promise(resolve=>setTimeout(resolve,70));
    }
    assert.equal(await read(file),expected,`Wrong private fixture output ${file}`);
  };
  const ownerBefore=await physicalOwnerSnapshot();
  for(let cycle=1;cycle<=3;cycle++){
    const click=await desktop('windows.private_desktop.accessibility.invoke_button',
      request('nxOwnerButton'))as{data:{inputDesktop:string;processId:number}};
    assert.equal(click.data.inputDesktop,'Default');
    assert.equal(click.data.processId,launch.data.pid);
    await settle('button.txt',String(cycle));
    const entry=await desktop('windows.private_desktop.accessibility.set_edit_value',{
      ...request('nxOwnerEdit'),value:'cycle-'+cycle,
    })as{data:{inputDesktop:string}};
    assert.equal(entry.data.inputDesktop,'Default');
    await settle('edit.txt','cycle-'+cycle);
    const check=await desktop('windows.private_desktop.accessibility.set_checkbox',{
      ...request('nxOwnerCheck'),checked:cycle%2===1,
    })as{data:{inputDesktop:string}};
    assert.equal(check.data.inputDesktop,'Default');
    await settle('check.txt',cycle%2===1?'true':'false');
    const radio=await desktop('windows.private_desktop.accessibility.select_radio',
      request(cycle%2===1?'nxOwnerRadioB':'nxOwnerRadioA'))as{
      data:{inputDesktop:string;selected:boolean}};
    assert.equal(radio.data.inputDesktop,'Default');
    assert.equal(radio.data.selected,true);
    await settle('radio.txt',cycle%2===1?'b':'a');
    const status=await desktop('windows.private_desktop.status',{})as{
      data:{running:boolean;inputDesktop:string}};
    assert.equal(status.data.running,true);
    assert.equal(status.data.inputDesktop,'Default');
  }
  const ownerAfter=await physicalOwnerSnapshot();
  assert.equal(ownerAfter,ownerBefore,
    'DEV physical mouse position or foreground window changed during private-only actions');
});
