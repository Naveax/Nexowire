import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrivateFilePickerAdapter} from '../src/agent/windows-private-file-picker.js';

const grant='11111111-1111-4111-8111-111111111111';
const stamp='2026-10-20T10:00:00.000Z';
const good={
  hwnd:'0x5678',expected_process_id:3214,expected_session_id:17,
  expected_desktop_started_at:stamp,
  filename_edit:{automation_id:'FileNameControlHost',expected_class:'Edit'},
  confirm_button:{automation_id:'OpenButton',expected_class:'Button'},
};
const code=(expected:string)=>(e:unknown)=>e instanceof Error&&
  'code'in e&&e.code===expected;

function fixture(){
  const status={
    running:true,desktopName:'NexowirePrivate',inputDesktop:'Default',
    startedAt:stamp,launchedPids:[3214],
  };
  const windows={
    inputDesktop:'Default',windows:[{hwnd:good.hwnd,processId:3214,title:'Open'}],
  };
  const scan={
    hwnd:good.hwnd,processId:3214,sessionId:17,inputDesktop:'Default',
    truncated:false,skipped:0,foreignProcessNodesSkipped:0,
    nodes:[
      {processId:3214,controlType:'ControlType.Edit',
        automationId:'FileNameControlHost',className:'Edit',
        enabled:true,offscreen:false,rect:{left:4,top:3,width:300,height:20}},
      {processId:3214,controlType:'ControlType.Button',
        automationId:'OpenButton',className:'Button',
        enabled:true,offscreen:false,rect:{left:350,top:3,width:75,height:20}},
    ],
  };
  const calls:string[]=[];
  const dispatch=async(action:string)=>{
    calls.push(action);
    if(action==='windows.private_desktop.status')return {data:status};
    if(action==='windows.private_desktop.windows')return {data:windows};
    if(action==='windows.private_desktop.accessibility')return {data:scan};
    if(action==='windows.private_desktop.accessibility.set_edit_value')
      return {data:{actionCompleted:true,processId:3214,sessionId:17,
        inputDesktop:'Default'}};
    if(action==='windows.private_desktop.accessibility.invoke_button')
      return {data:{actionCompleted:true,processId:3214,sessionId:17,
        inputDesktop:'Default'}};
    throw new Error('Unexpected dispatch '+action);
  };
  let id=0;
  const adapter=createPrivateFilePickerAdapter(dispatch,()=>0,
    ()=>id++===0?grant:'22222222-2222-4222-8222-222222222222');
  const mutations=()=>calls.filter(c=>c.endsWith('set_edit_value')||
    c.endsWith('invoke_button'));
  return {status,windows,scan,calls,adapter,mutations};
}
test('UAC/secure desktop and unknown input desktop fail before preparing grants',async()=>{
  for(const inputDesktop of ['Winlogon','SecureDesktop','UAC','', 'NexowirePrivate']){
    const f=fixture();f.status.inputDesktop=inputDesktop;
    await assert.rejects(f.adapter.prepare(good),code('PICKER_DESKTOP_UNSAFE'));
    assert.deepEqual(f.mutations(),[]);
  }
});
test('desktop switch after grant cancels operation before UIA edit',async()=>{
  const f=fixture();
  await f.adapter.prepare(good);
  f.status.inputDesktop='Winlogon';
  await assert.rejects(f.adapter.select({grant_id:grant,path:'C:\\Temp\\fixture.txt'}),
    code('PICKER_DESKTOP_UNSAFE'));
  assert.deepEqual(f.mutations(),[]);
});
test('foreign PID controls and ambiguous COM buttons cannot mint a grant',async()=>{
  const f=fixture();
  f.scan.nodes[0]!.processId=9999;
  await assert.rejects(f.adapter.prepare(good),code('PICKER_CONTROL_NOT_UNIQUE'));
  assert.deepEqual(f.mutations(),[]);
  f.scan.nodes[0]!.processId=3214;
  f.scan.nodes.push({...f.scan.nodes[1]!});
  await assert.rejects(f.adapter.prepare(good),code('PICKER_CONTROL_NOT_UNIQUE'));
  assert.deepEqual(f.mutations(),[]);
});
test('HWND reuse, PID replacement or session swap invalidates pending grant',async()=>{
  for(const change of ['hwnd','pid','session','generation']){
    const f=fixture();await f.adapter.prepare(good);
    if(change==='hwnd')f.windows.windows[0]!.hwnd='0x9999';
    if(change==='pid')f.windows.windows[0]!.processId=9999;
    if(change==='session')f.scan.sessionId=18;
    if(change==='generation')f.status.startedAt='2026-10-20T11:00:00.000Z';
    const expected=change==='hwnd'||change==='pid'?'PICKER_WINDOW_CHANGED':
      change==='session'?'PICKER_IDENTITY_CHANGED':'PICKER_DESKTOP_RESTARTED';
    await assert.rejects(
      f.adapter.select({grant_id:grant,path:'C:\\Temp\\fixture.txt'}),code(expected));
    assert.deepEqual(f.mutations(),[]);
  }
});
test('secure desktop transition after private edit forbids confirmation click',async()=>{
  const f=fixture();
  let edit=false;
  const adapter=createPrivateFilePickerAdapter(async(action:string)=>{
    f.calls.push(action);
    if(action==='windows.private_desktop.status')return {data:f.status};
    if(action==='windows.private_desktop.windows')return {data:f.windows};
    if(action==='windows.private_desktop.accessibility')return {data:f.scan};
    if(action==='windows.private_desktop.accessibility.set_edit_value'){
      edit=true;f.status.inputDesktop='Winlogon';
      return {data:{actionCompleted:true,processId:3214,sessionId:17,inputDesktop:'Default'}};
    }
    if(action==='windows.private_desktop.accessibility.invoke_button')
      throw Error('Never invoke after UAC');
    throw Error('unexpected '+action);
  },()=>0,()=>grant);
  await adapter.prepare(good);
  await assert.rejects(
    adapter.select({grant_id:grant,path:'C:\\Temp\\fixture.txt'}),
    code('PICKER_PARTIAL_EDIT'));
  assert.equal(edit,true);
  assert.equal(f.calls.filter(x=>x.endsWith('invoke_button')).length,0);
  await assert.rejects(
    adapter.select({grant_id:grant,path:'C:\\Temp\\fixture.txt'}),
    code('PICKER_GRANT_INVALID'));
});
test('cancelled grant cannot reuse the previous HWND identity',async()=>{
  const f=fixture();
  await f.adapter.prepare(good);
  assert.equal((await f.adapter.cancel({grant_id:grant})).data.revoked,true);
  await assert.rejects(
    f.adapter.select({grant_id:grant,path:'C:\\Temp\\fixture.txt'}),
    code('PICKER_GRANT_INVALID'));
  assert.deepEqual(f.mutations(),[]);
});
