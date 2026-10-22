import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createPrivateFilePickerAdapter,
  executeWindowsPrivateFilePickerCapability,
} from '../src/agent/windows-private-file-picker.js';
import {
  requireProtectedPrivateDesktopOwner,
  PrivateDesktopRuntimeGateError,
  PRIVATE_DESKTOP_OWNER_WITNESS_UNAVAILABLE,
} from '../src/agent/private-desktop-runtime-owner-gate.js';
import {PathPolicy} from '../src/agent/path-policy.js';
import {assertNoObviousPrivateShellBrokerInvocation}
  from '../src/agent/windows-private-shell-broker-guard.js';

const grant='11111111-1111-4111-8111-111111111111';
const started='2026-10-22T06:00:00.000Z';
const target={
  hwnd:'0xACE',expected_process_id:43155,expected_session_id:7,
  expected_desktop_started_at:started,
  filename_edit:{automation_id:'FileName',expected_class:'Edit'},
  confirm_button:{automation_id:'Accept',expected_class:'Button'},
};
const untrusted=(e:unknown)=>e instanceof PrivateDesktopRuntimeGateError&&
  e.code===PRIVATE_DESKTOP_OWNER_WITNESS_UNAVAILABLE;
// The production picker is Windows-only. On other operating systems the
// earlier platform rejection is the expected safe outcome, not a forged
// protected Job witness. Keep the Windows-specific owner check strict.
const platformOrOwnerReject=(e:unknown)=>{
  if(process.platform==='win32')return untrusted(e);
  return e instanceof Error&&'code'in e&&e.code==='WINDOWS_REQUIRED';
};

test('production picker refuses forged tracked PID before querying any real UIA',async()=>{
  // No native Job/HANDLE collector is installed. Forged state.launchedPids
  // and owner-supplied process info are not OS process identity evidence.
  await assert.rejects(
    executeWindowsPrivateFilePickerCapability(
      'windows.private_desktop.file_picker.prepare',target,new PathPolicy(['*'])),
    platformOrOwnerReject,
  );
  const realAdapter=createPrivateFilePickerAdapter();
  await assert.rejects(realAdapter.prepare(target),platformOrOwnerReject);
  // The OS-agnostic protected owner gate itself always rejects when no
  // authenticated retained Job/HANDLE collector was installed by #03.
  await assert.rejects(requireProtectedPrivateDesktopOwner('picker'),untrusted);
  await assert.rejects(requireProtectedPrivateDesktopOwner('launch'),untrusted);
  await assert.rejects(requireProtectedPrivateDesktopOwner('stop'),untrusted);
});

test('production picker respects emergency stop marker before owner read or UIA',{
  skip:process.platform!=='win32',
},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx09-picker-owner-'));
  const old=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=root;
  t.after(async()=>{
    if(old===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=old;
    await fs.rm(root,{recursive:true,force:true});
  });
  await fs.writeFile(path.join(root,'emergency-stop.pending'),'STOP_REQUESTED\n');
  await assert.rejects(createPrivateFilePickerAdapter().prepare(target),
    e=>e instanceof Error&&'code'in e&&e.code==='PRIVATE_DESKTOP_EMERGENCY_STOP_PENDING');
});

test('synthetic same-PID picker switches to foreign COM child before edit: no dispatch',async()=>{
  const status={
    running:true,desktopName:'NexowirePrivate',inputDesktop:'Default',
    startedAt:started,launchedPids:[43155],
  };
  const listing={inputDesktop:'Default',
    windows:[{hwnd:'0xACE',processId:43155,title:'synthetic file open'}]};
  const node=(type:string,id:string)=>({
    processId:43155,controlType:'ControlType.'+type,
    automationId:id,className:type,enabled:true,offscreen:false,
    rect:{left:10,top:10,width:100,height:20},
  });
  const scan={hwnd:'0xACE',processId:43155,sessionId:7,
    inputDesktop:'Default',truncated:false,skipped:0,
    foreignProcessNodesSkipped:0,nodes:[node('Edit','FileName'),node('Button','Accept')]};
  const mutations:string[]=[];
  const dispatch=async(capability:string):Promise<unknown>=>{
    if(capability==='windows.private_desktop.status')return{data:status};
    if(capability==='windows.private_desktop.windows')return{data:listing};
    if(capability==='windows.private_desktop.accessibility')return{data:scan};
    mutations.push(capability);
    throw new Error('Never operate real owner desktop!');
  };
  const adapter=createPrivateFilePickerAdapter(dispatch,()=>0,()=>grant);
  await adapter.prepare(target);
  // A COM dialog can replace its host with a different PID even when HWND
  // and owner-visible title are unchanged. No default-desktop fallback.
  listing.windows[0]!.processId=51000;
  scan.processId=51000;
  await assert.rejects(adapter.select({grant_id:grant,path:'C:\\Temp\\fixture.txt'}),
    e=>e instanceof Error&&'code'in e&&e.code==='PICKER_WINDOW_CHANGED');
  assert.deepEqual(mutations,[]);
  await assert.rejects(adapter.select({grant_id:grant,path:'C:\\Temp\\fixture.txt'}),
    e=>e instanceof Error&&'code'in e&&e.code==='PICKER_GRANT_INVALID');
});

test('signed CORE evidence from another Broker cannot become a private picker owner',async()=>{
  const source=await fs.readFile(new URL(
    '../src/agent/windows-private-file-picker.ts',import.meta.url),'utf8');
  assert.match(source,/requireProtectedPrivateDesktopOwner\('picker'\)/);
  assert.match(source,/dispatch===executeWindowsPrivateDesktopCapability/);
  // Source cannot bypass into external Explorer, Common Item Dialog,
  // Winlogon/Secure Desktop focus or a generic elevated CORE path.
  assert.doesNotMatch(source,/SetForegroundWindow|SwitchDesktop|SendInput|consent\.exe/);
  for(const [executable,args] of [
    ['cmd.exe',['/C','call regsvr32.exe /s forged.dll']],
    ['powershell.exe',['-Command','New-Object -ComObject Shell.Application']],
    ['powershell.exe',['-Command','Start-Process calc.exe -Verb RunAs']],
    ['cmd.exe',['/C','wsl.exe --exec explorer.exe']],
  ] as const){
    assert.throws(
      ()=>assertNoObviousPrivateShellBrokerInvocation(executable,args),
      e=>e instanceof Error&&'code'in e&&
        e.code==='AI_PRIVATE_SHELL_BROKER_NOT_ISOLATED',
    );
  }
});

test('stop and protected CORE policy remain independent from picker forgery',async()=>{
  const source=await fs.readFile(new URL(
    '../src/agent/private-desktop-runtime-owner-gate.ts',import.meta.url),'utf8');
  assert.match(source,/verifyPrivateDesktopOwnerFence/);
  assert.match(source,/operation==='picker'\?'private-uia'/);
  // A verified synthetic witness is still an inert source-only record.
  assert.doesNotMatch(source,/taskkill\.exe|SetForegroundWindow|SwitchDesktop|consent\.exe/);
});
