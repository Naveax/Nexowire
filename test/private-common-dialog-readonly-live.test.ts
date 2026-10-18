import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';
import {executeWindowsWindowCapability} from '../src/agent/windows-window-control.js';
import {createPrivateFilePickerAdapter} from '../src/agent/windows-private-file-picker.js';

// Opt-in physical Windows test. Modern Common Item Dialog is launched only
// by an isolated throwaway process. Never click/SetValue, call ShellExecute,
// activate the owner's desktop or automate the user's input.
test('read-only modern WinForms Common Item Dialog identity on private desktop',{
  skip:process.platform!=='win32'||process.env.NEXOWIRE_PRIVATE_COMMON_DIALOG_LIVE!=='1',
  timeout:95_000,
},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nx-cid-readonly-'));
  const prior=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const priorSkip=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=dir;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await desktop('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(prior===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=prior;
    if(priorSkip===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=priorSkip;
    await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:150});
  });
  const script=path.join(dir,'common-dialog-readonly.ps1');
  await fs.writeFile(script,[
    '$ErrorActionPreference="Stop"',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dlg=New-Object System.Windows.Forms.OpenFileDialog',
    '$dlg.AutoUpgradeEnabled=$true',
    '$dlg.CheckFileExists=$true',
    '$dlg.Multiselect=$false',
    "$dlg.Title='NX_PRIVATE_COMMON_ITEM_READONLY'",
    '$dlg.RestoreDirectory=$true',
    'try{[void]$dlg.ShowDialog()}finally{$dlg.Dispose()}',
  ].join('\n'),'utf8');
  const started=await desktop('windows.private_desktop.start',{create_shortcut:false}) as{
    data:{inputDesktop:string};
  };
  assert.equal(started.data.inputDesktop,'Default');
  const launch=await desktop('windows.private_desktop.launch',{
    executable:'powershell.exe',
    args:['-NoLogo','-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',script],
  }) as {data:{pid:number}};
  let dialog:{hwnd:string;processId:number}|undefined;
  for(let tries=0;tries<24;tries++){
    const windows=await desktop('windows.private_desktop.windows',{}) as{
      data:{inputDesktop:string;windows:Array<{hwnd:string;title:string;processId:number}>};
    };
    assert.equal(windows.data.inputDesktop,'Default');
    dialog=windows.data.windows.find(x=>x.title==='NX_PRIVATE_COMMON_ITEM_READONLY');
    if(dialog)break;
    await new Promise(resolve=>setTimeout(resolve,180));
  }
  assert.ok(dialog,'Modern dialog not enumerated on isolated desktop; acceptance blocked');
  assert.equal(dialog.processId,launch.data.pid,
    'Cross-process Explorer/COM dialog must not be treated as same-PID picker');
  const physical=await executeWindowsWindowCapability('windows.window.list',{}) as{
    data:{foregroundHwnd:string|null;windows:Array<{hwnd:string;processId:number}>};
  };
  assert.equal(physical.data.windows.some(w=>w.processId===launch.data.pid),false,
    'Private dialog must not appear in Default window enumeration');
  assert.notEqual(physical.data.foregroundHwnd?.toLowerCase(),dialog.hwnd.toLowerCase());
  const scan=await desktop('windows.private_desktop.accessibility',{hwnd:dialog.hwnd}) as{
    data:{processId:number;sessionId:number;inputDesktop:string;truncated:boolean;
      nodes:Array<{controlType:string;className:string;automationId:string}>};
  };
  assert.equal(scan.data.inputDesktop,'Default');
  assert.equal(scan.data.processId,launch.data.pid);
  assert.ok(scan.data.sessionId>=0);
  console.log('CID identity evidence: private=true, samePid=true, '+
    'sessionVerified=true, semanticEdits='+
    scan.data.nodes.filter(n=>n.controlType==='ControlType.Edit').length+
    ', semanticButtons='+
    scan.data.nodes.filter(n=>n.controlType==='ControlType.Button').length+
    ', truncated='+scan.data.truncated);
  // Never make native control assumptions. A non-unique or unsupported
  // UIA inventory must fail closed at token preparation.
  const edit=scan.data.nodes.filter(x=>x.controlType==='ControlType.Edit');
  const button=scan.data.nodes.filter(x=>x.controlType==='ControlType.Button');
  const candidateEdit=edit[0]??{automationId:'not-a-real-edit',className:'Unknown'};
  const candidateButton=button[0]??{automationId:'not-a-real-button',className:'Unknown'};
  const status=await desktop('windows.private_desktop.status',{}) as{
    data:{startedAt:string;inputDesktop:string};
  };
  const picker=createPrivateFilePickerAdapter();
  const preflight={
    hwnd:dialog.hwnd,expected_process_id:launch.data.pid,
    expected_session_id:scan.data.sessionId,
    expected_desktop_started_at:status.data.startedAt,
    filename_edit:{automation_id:candidateEdit.automationId,expected_class:candidateEdit.className},
    confirm_button:{automation_id:candidateButton.automationId,expected_class:candidateButton.className},
  };
  // Real negative owner/session/start-generation tests: all must fail
  // before mutating any UIA control or issuing an owner-console request.
  const denies=(code:string)=>(error:unknown)=>
    !!error&&typeof error==='object'&&'code'in error&&error.code===code;
  await assert.rejects(picker.prepare({
    ...preflight,expected_process_id:launch.data.pid+100_000,
  }),denies('PICKER_PROCESS_UNTRACKED'));
  await assert.rejects(picker.prepare({
    ...preflight,expected_session_id:scan.data.sessionId+100,
  }),denies('PICKER_IDENTITY_CHANGED'));
  await assert.rejects(picker.prepare({
    ...preflight,expected_desktop_started_at:'2000-01-01T00:00:00.000Z',
  }),denies('PICKER_DESKTOP_RESTARTED'));
  // Never submit a real file. This test only measures read-only inventory.
  // Force an untrusted control identifier and require no token minting.
  preflight.filename_edit.automation_id='not-a-trusted-native-file-name-id';
  await assert.rejects(picker.prepare(preflight),error=>
    !!error&&typeof error==='object'&&'code'in error&&
    ['PICKER_CONTROL_NOT_UNIQUE','PICKER_INVENTORY_INCOMPLETE',
      'PICKER_CONTROL_UNAVAILABLE'].includes(String(error.code)));
  const end=await desktop('windows.private_desktop.status',{}) as{
    data:{inputDesktop:string};
  };
  assert.equal(end.data.inputDesktop,'Default');
  await desktop('windows.private_desktop.stop',{});
  await assert.rejects(picker.prepare(preflight),denies('PICKER_DESKTOP_UNSAFE'));
});
