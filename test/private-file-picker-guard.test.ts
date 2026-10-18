import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrivateFilePickerAdapter} from '../src/agent/windows-private-file-picker.js';
import {isReadOnlyCapability} from '../src/protocol/capabilities.js';
import {MCP_TOOL_CAPABILITY_REQUIREMENTS} from '../src/mcp/tool-capabilities.js';

const grantId='11111111-1111-4111-8111-111111111111';
const startedAt='2026-10-18T11:00:00.000Z';
const input={
  hwnd:'0x1234',expected_process_id:4321,
  expected_session_id:2,expected_desktop_started_at:startedAt,
  filename_edit:{automation_id:'1148',expected_class:'Edit'},
  confirm_button:{automation_id:'1',expected_class:'Button'},
};
function errorCode(code:string){
  return (error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code===code;
}
function fixture(){
  let ms=0,changed=false;
  const status={running:true,desktopName:'NexowirePrivate',
    inputDesktop:'Default',startedAt,launchedPids:[4321]};
  const listing={inputDesktop:'Default',windows:[{hwnd:'0x1234',processId:4321,title:'Open'}]};
  const scan={hwnd:'0x1234',processId:4321,sessionId:2,inputDesktop:'Default',
    truncated:false,skipped:0,foreignProcessNodesSkipped:0,
    nodes:[
      {processId:4321,controlType:'ControlType.Edit',automationId:'1148',
        className:'Edit',enabled:true,offscreen:false,
        rect:{left:2,top:2,width:180,height:28}},
      {processId:4321,controlType:'ControlType.Button',automationId:'1',
        className:'Button',enabled:true,offscreen:false,
        rect:{left:200,top:2,width:80,height:28}},
    ],
  };
  const calls:string[]=[];
  const dispatch=async(capability:string,raw:unknown):Promise<unknown>=>{
    calls.push(capability);
    const request=raw as {expected_process_id?:number;expected_session_id?:number};
    if(capability==='windows.private_desktop.status')return {data:status};
    if(capability==='windows.private_desktop.windows')return {data:listing};
    if(capability==='windows.private_desktop.accessibility')return {data:scan};
    if(request.expected_process_id!==4321||request.expected_session_id!==2)
      throw new Error('Action helper missing identity binding');
    if(changed){listing.windows[0]!.processId=5000;}
    return {data:{processId:4321,sessionId:2,inputDesktop:'Default',
      actionCompleted:true}};
  };
  const adapter=createPrivateFilePickerAdapter(dispatch,()=>ms,()=>grantId);
  return {adapter,status,listing,scan,calls,setClock:(n:number)=>{ms=n;},
    setChange:()=>{changed=true;}};
}
test('file-picker surface classifies grant minting and use as mutations',()=>{
  assert.equal(isReadOnlyCapability('windows.private_desktop.file_picker.prepare'),false);
  assert.equal(isReadOnlyCapability('windows.private_desktop.file_picker.select'),false);
  assert.equal(isReadOnlyCapability('windows.private_desktop.file_picker.cancel'),false);
  assert.equal(MCP_TOOL_CAPABILITY_REQUIREMENTS.windows_private_desktop_file_picker_select,
    'windows.private_desktop.file_picker.select');
});
test('private adapter uses only tracked private UIA, not physical focus or keyboard',async()=>{
  const f=fixture();
  const prepared=await f.adapter.prepare(input);
  assert.equal(prepared.data.grantId,grantId);
  assert.equal(prepared.data.ownerApprovalGranted,false);
  const out=await f.adapter.select({grant_id:grantId,path:'C:\\Temp\\example.txt'});
  assert.equal(out.data.submitted,true);
  assert.equal(out.data.selectionVerified,false);
  assert.equal(out.data.touchesPhysicalInput,false);
  assert.equal(f.calls.filter(c=>c.endsWith('set_edit_value')).length,1);
  assert.equal(f.calls.filter(c=>c.endsWith('invoke_button')).length,1);
  assert.ok(f.calls.every(c=>c.startsWith('windows.private_desktop.')));
  await assert.rejects(f.adapter.select({grant_id:grantId,path:'C:\\Temp\\example.txt'}),
    errorCode('PICKER_GRANT_INVALID'));
});
test('preparation rejects nonprivate, untracked, recycled, wrong session and incomplete controls',async()=>{
  const mutations:Array<(f:ReturnType<typeof fixture>)=>void>=[
    f=>{f.status.inputDesktop='Winlogon';},
    f=>{f.status.running=false;},
    f=>{f.status.startedAt='2026-10-18T10:00:00.000Z';},
    f=>{f.status.launchedPids=[];},
    f=>{f.listing.windows[0]!.processId=9999;},
    f=>{f.scan.processId=9999;},
    f=>{f.scan.sessionId=3;},
    f=>{f.scan.inputDesktop='Winlogon';},
    f=>{f.scan.truncated=true;},
    f=>{f.scan.foreignProcessNodesSkipped=1;},
    f=>{f.scan.nodes[0]!.enabled=false;},
    f=>{f.scan.nodes[1]!.offscreen=true;},
    f=>{f.scan.nodes.push({...f.scan.nodes[1]!});},
  ];
  for(const mutate of mutations){
    const f=fixture();mutate(f);
    await assert.rejects(f.adapter.prepare(input));
    assert.equal(f.calls.some(c=>c.endsWith('set_edit_value')||c.endsWith('invoke_button')),false);
  }
});
test('grant revocation and expiry forbid actions',async()=>{
  const f=fixture();await f.adapter.prepare(input);
  assert.equal((await f.adapter.cancel({grant_id:grantId})).data.revoked,true);
  await assert.rejects(f.adapter.select({grant_id:grantId,path:'C:\\Temp\\file.txt'}),
    errorCode('PICKER_GRANT_INVALID'));
  await f.adapter.prepare(input);f.setClock(60_001);
  await assert.rejects(f.adapter.select({grant_id:grantId,path:'C:\\Temp\\file.txt'}),
    errorCode('PICKER_GRANT_INVALID'));
});
test('invalid absolute/device/UNC paths are rejected without UIA writes',async()=>{
  for(const value of ['relative.txt','\\\\server\\share\\file.txt',
    '\\\\?\\C:\\a.txt','\\\\.\\C:','C:\\Temp\\bad\n.txt']){
    const f=fixture();await f.adapter.prepare(input);
    await assert.rejects(f.adapter.select({grant_id:grantId,path:value}),
      errorCode('PICKER_PATH_UNSAFE'));
    assert.equal(f.calls.some(c=>c.endsWith('set_edit_value')),false);
  }
});
test('window replacement between edit and confirmation prevents click',async()=>{
  const f=fixture();f.setChange();
  await f.adapter.prepare(input);
  await assert.rejects(f.adapter.select({grant_id:grantId,path:'C:\\Temp\\file.txt'}),
    errorCode('PICKER_PARTIAL_EDIT'));
  assert.equal(f.calls.some(c=>c.endsWith('invoke_button')),false);
});
test('native action error after invocation starts is never blindly replayed',async()=>{
  const f=fixture();const original=f.adapter;
  await original.prepare(input);
  // Inject changing input desktop only at confirmation, after the edit.
  const g=fixture();const calls:string[]=[];
  const adapter=createPrivateFilePickerAdapter(async(cap,inputArg)=>{
    calls.push(cap);
    if(cap==='windows.private_desktop.accessibility.invoke_button')throw new Error('timeout');
    const data={
      'windows.private_desktop.status':{running:true,desktopName:'NexowirePrivate',
        inputDesktop:'Default',startedAt,launchedPids:[4321]},
      'windows.private_desktop.windows':{inputDesktop:'Default',
        windows:[{hwnd:'0x1234',processId:4321,title:'Open'}]},
      'windows.private_desktop.accessibility':g.scan,
    } as Record<string,unknown>;
    if(cap==='windows.private_desktop.accessibility.set_edit_value')
      return {data:{processId:4321,sessionId:2,inputDesktop:'Default',actionCompleted:true}};
    return {data:data[cap]};
  },()=>0,()=>grantId);
  await adapter.prepare(input);
  await assert.rejects(adapter.select({grant_id:grantId,path:'C:\\Temp\\file.txt'}),
    errorCode('PICKER_MUTATION_STATE_UNKNOWN'));
  assert.equal(calls.filter(c=>c.endsWith('invoke_button')).length,1);
  await assert.rejects(adapter.select({grant_id:grantId,path:'C:\\Temp\\file.txt'}),
    errorCode('PICKER_GRANT_INVALID'));
});

test('file-picker helper timeout after edit dispatch is unknown, never safe to replay',async()=>{
  const f=fixture();let invoked=0;
  const adapter=createPrivateFilePickerAdapter(async(cap,raw)=>{
    if(cap==='windows.private_desktop.accessibility.set_edit_value')
      throw new Error('synthetic helper timeout after dispatch');
    if(cap==='windows.private_desktop.accessibility.invoke_button'){invoked++;throw new Error('unexpected');}
    if(cap==='windows.private_desktop.status')return {data:f.status};
    if(cap==='windows.private_desktop.windows')return {data:f.listing};
    if(cap==='windows.private_desktop.accessibility')return {data:f.scan};
    throw new Error('Unexpected capability '+cap);
  },()=>0,()=>grantId);
  await adapter.prepare(input);
  await assert.rejects(adapter.select({grant_id:grantId,path:'C:\\Temp\\abc.txt'}),
    errorCode('PICKER_EDIT_STATE_UNKNOWN'));
  assert.equal(invoked,0);
  await assert.rejects(adapter.select({grant_id:grantId,path:'C:\\Temp\\abc.txt'}),
    errorCode('PICKER_GRANT_INVALID'));
});
test('emergency desktop stop invalidates grant before private UIA mutation',async()=>{
  const f=fixture();await f.adapter.prepare(input);
  f.status.running=false;
  await assert.rejects(f.adapter.select({grant_id:grantId,path:'C:\\Temp\\abc.txt'}),
    errorCode('PICKER_DESKTOP_UNSAFE'));
  assert.equal(f.calls.some(c=>c.endsWith('set_edit_value')),false);
});
test('cancellation during bounded edit prevents subsequent file-picker confirmation',async()=>{
  const f=fixture();let continueEdit!:()=>void,started!:()=>void;
  const startedPromise=new Promise<void>(resolve=>{started=resolve;});
  const hold=new Promise<void>(resolve=>{continueEdit=resolve;});
  const adapter=createPrivateFilePickerAdapter(async(cap,raw)=>{
    if(cap==='windows.private_desktop.accessibility.set_edit_value'){
      started();await hold;
      return {data:{processId:4321,sessionId:2,inputDesktop:'Default',actionCompleted:true}};
    }
    if(cap==='windows.private_desktop.accessibility.invoke_button')
      throw new Error('Cancelled operation invoked unexpectedly');
    if(cap==='windows.private_desktop.status')return {data:f.status};
    if(cap==='windows.private_desktop.windows')return {data:f.listing};
    if(cap==='windows.private_desktop.accessibility')return {data:f.scan};
    throw new Error('Unexpected capability '+cap);
  },()=>0,()=>grantId);
  await adapter.prepare(input);
  const selection=adapter.select({grant_id:grantId,path:'C:\\Temp\\abc.txt'});
  await startedPromise;
  assert.equal((await adapter.cancel({grant_id:grantId})).data.revoked,true);
  continueEdit();
  await assert.rejects(selection,errorCode('PICKER_PARTIAL_EDIT'));
});
