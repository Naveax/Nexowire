import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {verifyWindowsKernelJob} from '../src/agent/windows-job-kernel-attestation.js';
import {assertNoObviousPrivateShellBrokerInvocation} from '../src/agent/windows-private-shell-broker-guard.js';
import {createPrivateFilePickerAdapter} from '../src/agent/windows-private-file-picker.js';

const denied=(code:string)=>(error:unknown):boolean=>
  error instanceof Error&&'code'in error&&error.code===code;

test('private desktop stop is still PID-only: cannot borrow #576 verified Job attestation',async()=>{
  const src=await readFile(new URL('../src/agent/windows-private-desktop.ts',import.meta.url),'utf8');
  const stop=src.match(/async function killTree\(pid:number\)[\s\S]*?(?=async function stop\(\))/)?.[0];
  assert.ok(stop,'inspect actual private desktop killTree implementation');
  assert.match(stop,/taskkill\.exe/);
  assert.match(stop,/\['\/PID',String\(pid\),'\/T','\/F'\]/);
  assert.doesNotMatch(stop,/verifyWindowsKernelJob|creationFiletime|IsProcessInJob|guardianJobHandle/);
  // WARNING-only acceptance: this is explicit evidence of a *missing*
  // trust boundary, not a test that a foreign PID has been harmed.
});

test('Job V5 proof rejects forged PIDs/ticks/guardian handles before any OS query',{
  skip:process.platform!=='win32',
},async()=>{
  for(const args of [
    [0,'133000000000000000',123,'1'],
    [123,'invalid',123,'1'],
    [123,'133000000000000000',0,'1'],
    [123,'133000000000000000',456,'0'],
  ] as const){
    await assert.rejects(
      verifyWindowsKernelJob(args[0],args[1],args[2],args[3]),
      /WINDOWS_JOB_KERNEL_INVALID_PROOF_INPUT/,
    );
  }
});

test('private picker never follows Explorer cross-PID dialog/foreground after grant',async()=>{
  const grant='11111111-1111-4111-8111-111111111111';
  const started='2026-10-21T11:00:00.000Z';
  const input={
    hwnd:'0xA700',expected_process_id:32001,
    expected_session_id:18,expected_desktop_started_at:started,
    filename_edit:{automation_id:'FileName',expected_class:'Edit'},
    confirm_button:{automation_id:'Accept',expected_class:'Button'},
  };
  const status={
    running:true,desktopName:'NexowirePrivate',inputDesktop:'Default',
    startedAt:started,launchedPids:[32001],
  };
  const listing={
    inputDesktop:'Default',
    windows:[{hwnd:'0xA700',processId:32001,title:'Open'}],
  };
  const node=(kind:'Edit'|'Button',id:string)=>({
    processId:32001,controlType:'ControlType.'+kind,automationId:id,
    className:kind,enabled:true,offscreen:false,
    rect:{left:2,top:2,width:100,height:20},
  });
  const scan={
    hwnd:'0xA700',processId:32001,sessionId:18,inputDesktop:'Default',
    skipped:0,truncated:false,foreignProcessNodesSkipped:0,
    nodes:[node('Edit','FileName'),node('Button','Accept')],
  };
  const calls:string[]=[];
  const dispatch=async(cap:string):Promise<unknown>=>{
    calls.push(cap);
    if(cap==='windows.private_desktop.status')return{data:status};
    if(cap==='windows.private_desktop.windows')return{data:listing};
    if(cap==='windows.private_desktop.accessibility')return{data:scan};
    throw Error('Unsafe private/owner input dispatched: '+cap);
  };
  const adapter=createPrivateFilePickerAdapter(dispatch,()=>0,()=>grant);
  await adapter.prepare(input);

  // Explorer File Open migrates to a new window/PID not tied to the
  // original private CreateProcess launch. No cross-PID fallback.
  listing.windows[0]!.processId=39001;
  scan.processId=39001;
  scan.nodes[0]!.processId=39001;
  await assert.rejects(adapter.select({
    grant_id:grant,path:'C:\\Temp\\synthetic-file.txt',
  }),denied('PICKER_WINDOW_CHANGED'));
  assert.equal(calls.filter(x=>/set_edit_value|invoke_button|keyboard|mouse|foreground/i.test(x)).length,0);

  // Even after reverting the mock window, a partially consumed grant
  // must not be silently replayed.
  listing.windows[0]!.processId=32001;
  await assert.rejects(adapter.select({
    grant_id:grant,path:'C:\\Temp\\synthetic-file.txt',
  }),denied('PICKER_GRANT_INVALID'));
});

test('private picker secure desktop/emergency stop prohibits edit and click',async()=>{
  const grant='22222222-2222-4222-8222-222222222222';
  const stamp='2026-10-21T11:30:00.000Z';
  const input={
    hwnd:'0xB800',expected_process_id:32002,expected_session_id:18,
    expected_desktop_started_at:stamp,
    filename_edit:{automation_id:'FileName',expected_class:'Edit'},
    confirm_button:{automation_id:'Accept',expected_class:'Button'},
  };
  let running=true;
  let inputDesktop='Default';
  const actions:string[]=[];
  const dispatch=async(cap:string):Promise<unknown>=>{
    actions.push(cap);
    if(cap==='windows.private_desktop.status')return{
      data:{running,desktopName:'NexowirePrivate',inputDesktop,
        startedAt:stamp,launchedPids:[32002]},
    };
    if(cap==='windows.private_desktop.windows')return{
      data:{inputDesktop,windows:[{hwnd:'0xB800',processId:32002,title:'Open'}]},
    };
    if(cap==='windows.private_desktop.accessibility')return{
      data:{hwnd:'0xB800',processId:32002,sessionId:18,inputDesktop,
        skipped:0,truncated:false,foreignProcessNodesSkipped:0,
        nodes:[
          {processId:32002,controlType:'ControlType.Edit',automationId:'FileName',
           className:'Edit',enabled:true,offscreen:false,
           rect:{left:1,top:1,width:50,height:20}},
          {processId:32002,controlType:'ControlType.Button',automationId:'Accept',
           className:'Button',enabled:true,offscreen:false,
           rect:{left:60,top:1,width:50,height:20}},
        ]},
    };
    throw Error('Unsafe input dispatched: '+cap);
  };
  const a=createPrivateFilePickerAdapter(dispatch,()=>0,()=>grant);
  await a.prepare(input);
  running=false;inputDesktop='Winlogon';
  await assert.rejects(a.select({grant_id:grant,path:'C:\\Temp\\synthetic-file.txt'}),
    denied('PICKER_DESKTOP_UNSAFE'));
  assert.equal(actions.filter(x=>/set_edit_value|invoke_button|keyboard|mouse/i.test(x)).length,0);
});

test('known WSL/Terminal/COM indirect Windows wrappers remain denied with #576 Job integration',()=>{
  for(const [exe,args] of [
    ['cmd.exe',['/C','call regsvr32.exe /s fake.dll']],
    ['cmd.exe',['/C','schtasks.exe /run /tn Foreign']],
    ['powershell.exe',['-Command','New-Object -ComObject Shell.Application']],
    ['powershell.exe',['-Command','Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{}']],
    ['powershell.exe',['-Command','& wsl.exe --list']],
    ['cmd.exe',['/C','wt.exe -w 0']],
  ] as const)assert.throws(
    ()=>assertNoObviousPrivateShellBrokerInvocation(exe,args),
    denied('AI_PRIVATE_SHELL_BROKER_NOT_ISOLATED'),
    exe+' '+args.join(' '),
  );
});
