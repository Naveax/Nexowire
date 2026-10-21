import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  assertPrivateDesktopProcessProvenance,
  verifyPrivateDesktopOwnerFence,
  type PrivateDesktopLaunchIdentity,
  type PrivateDesktopKernelWitness,
  PrivateDesktopOwnerFenceError,
} from '../src/agent/private-desktop-owner-fence.js';
import {createPrivateFilePickerAdapter}
  from '../src/agent/windows-private-file-picker.js';
import {assertNoObviousPrivateShellBrokerInvocation}
  from '../src/agent/windows-private-shell-broker-guard.js';

const owner=():PrivateDesktopLaunchIdentity=>({
  pid:43123,creationTime100ns:'134059294000000000',
  sessionId:6,desktopGeneration:'desktop-generation-20261021',
  ownerEpoch:11,guardianPid:43100,
  guardianCreationTime100ns:'134059293990000000',
  jobHandleId:'guardian-unnamed-job-42',cancelEpoch:7,
});
const witness=():PrivateDesktopKernelWitness=>({
  processPid:43123,processCreationTime100ns:'134059294000000000',
  processSessionId:6,processDesktopName:'NexowirePrivate',
  guardianPid:43100,guardianCreationTime100ns:'134059293990000000',
  jobHandleId:'guardian-unnamed-job-42',
  isMemberOfGuardianJob:true,guardianJobVerified:true,collectorVerified:true,
  ownerEpoch:11,desktopGeneration:'desktop-generation-20261021',
  cancelEpoch:7,inputDesktop:'Default',processState:'running',
});
const failCode=(code:PrivateDesktopOwnerFenceError['code'])=>
  (e:unknown)=>e instanceof PrivateDesktopOwnerFenceError&&e.code===code;

test('identical PID does not prove owner: PID-reuse creation FILETIME mismatch fails',()=>{
  assert.throws(()=>assertPrivateDesktopProcessProvenance(owner(),{
    ...witness(),processCreationTime100ns:'134059294000000001',
  },'stop'),failCode('PRIVATE_DESKTOP_PROVENANCE_STALE'));
});

test('unverified guardian Job/handle membership cannot authorize private stop or UIA',()=>{
  for(const change of [
    {collectorVerified:false},
    {guardianJobVerified:false},
    {isMemberOfGuardianJob:false},
  ]){
    for(const action of ['stop','private-uia'] as const){
      assert.throws(()=>assertPrivateDesktopProcessProvenance(owner(),{
        ...witness(),...change,
      },action),failCode('PRIVATE_DESKTOP_JOB_NOT_VERIFIED'));
    }
  }
});

test('guardian restart and changed unnamed Job handle refuse stale child',()=>{
  for(const change of [
    {guardianPid:40001},
    {guardianCreationTime100ns:'134059294000000002'},
    {jobHandleId:'guardian-unnamed-job-NEW'},
  ]){
    assert.throws(()=>assertPrivateDesktopProcessProvenance(owner(),{
      ...witness(),...change,
    },'stop'),failCode('PRIVATE_DESKTOP_PROVENANCE_STALE'));
  }
});

test('wrong session, foreign desktop and process UNKNOWN forbid private GUI and stop',()=>{
  for(const change of [
    {processSessionId:8},
    {processDesktopName:'Default'},
    {processDesktopName:'Winlogon'},
    {desktopGeneration:'stale-desktop-generation'},
    {processState:'unknown' as const},
    {processState:'exited' as const},
  ]){
    assert.throws(()=>assertPrivateDesktopProcessProvenance(owner(),{
      ...witness(),...change,
    },'private-uia'),failCode('PRIVATE_DESKTOP_PROVENANCE_STALE'));
  }
});
test('emergency stop, owner revoke/re-pair and input desktop UAC fail closed',()=>{
  for(const change of [
    {ownerEpoch:12},
    {cancelEpoch:8},
  ])assert.throws(()=>assertPrivateDesktopProcessProvenance(owner(),{
    ...witness(),...change,
  },'stop'),failCode('PRIVATE_DESKTOP_OWNER_REVOKED'));
  for(const desktop of ['Winlogon','SecureDesktop','', 'NexowirePrivate']){
    assert.throws(()=>assertPrivateDesktopProcessProvenance(owner(),{
      ...witness(),inputDesktop:desktop,
    },'private-uia'),failCode('PRIVATE_DESKTOP_INPUT_DESKTOP_UNSAFE'));
  }
});
test('malformed or unsigned PID/creationTime record never authorizes mutation',()=>{
  const v=owner();
  for(const change of [
    {pid:0},{pid:Number.MAX_SAFE_INTEGER},{creationTime100ns:'0'},
    {creationTime100ns:'unexpected'},
    {guardianCreationTime100ns:'-100'},
    {sessionId:-1},{ownerEpoch:0},{cancelEpoch:-1},
    {jobHandleId:'x'},{desktopGeneration:'../escape'},
  ])assert.throws(()=>assertPrivateDesktopProcessProvenance({
    ...v,...change,
  },witness(),'stop'),failCode('PRIVATE_DESKTOP_PROVENANCE_MISSING'));
});
test('two protected witness reads must detect cancellation or PID-reuse between samples',async()=>{
  let reads=0;
  await assert.rejects(
    verifyPrivateDesktopOwnerFence(owner(),async()=>{
      reads++;return reads===1?witness():{...witness(),cancelEpoch:8};
    },'private-uia'),
    failCode('PRIVATE_DESKTOP_OWNER_REVOKED'),
  );
  assert.equal(reads,2);
  reads=0;
  await assert.rejects(
    verifyPrivateDesktopOwnerFence(owner(),async()=>{
      reads++;return reads===1?witness():{
        ...witness(),processCreationTime100ns:'134059294000000003',
      };
    },'stop'),
    failCode('PRIVATE_DESKTOP_PROVENANCE_STALE'),
  );
  assert.equal(reads,2);
});
test('verified synthetic witness is inert; cannot perform taskkill or UI actions',async()=>{
  const result=await verifyPrivateDesktopOwnerFence(owner(),
    async()=>witness(),'stop');
  assert.equal(result.pid,owner().pid);
  assert.equal(result.creationTime100ns,owner().creationTime100ns);
  assert.equal(Object.isFrozen(result),true);
  assert.equal('terminate'in result,false);
  assert.equal('handle'in result,false);
  assert.equal('uacApprove'in result,false);
});
test('real private desktop stop remains NOT wired to this proof (explicit production blocker)',async()=>{
  const src=await readFile(new URL('../src/agent/windows-private-desktop.ts',
    import.meta.url),'utf8');
  const stop=src.match(/async function killTree\(pid:number\)[\s\S]*?(?=async function stop\(\))/)?.[0];
  assert.ok(stop);
  assert.match(stop,/taskkill\.exe/);
  assert.doesNotMatch(stop,/verifyPrivateDesktopOwnerFence|creationTime100ns|IsProcessInJob/);
});
test('Explorer/COM and shell escape cannot get private focus or keyboard',async()=>{
  const win={inputDesktop:'Default',windows:[{hwnd:'0xA1',processId:43123,title:'Open'}]};
  const status={running:true,desktopName:'NexowirePrivate',
    inputDesktop:'Default',startedAt:'2026-10-21T18:56:00.000Z',
    launchedPids:[43123]};
  const nodes=[
    {processId:43123,controlType:'ControlType.Edit',automationId:'Filename',
      className:'Edit',enabled:true,offscreen:false,
      rect:{left:1,top:1,width:100,height:20}},
    {processId:43123,controlType:'ControlType.Button',automationId:'Open',
      className:'Button',enabled:true,offscreen:false,
      rect:{left:150,top:1,width:50,height:20}},
  ];
  const scan={hwnd:'0xA1',processId:43123,sessionId:6,
    inputDesktop:'Default',skipped:0,truncated:false,
    foreignProcessNodesSkipped:0,nodes};
  const calls:string[]=[];
  const dispatch=async(action:string)=>{
    calls.push(action);
    if(action==='windows.private_desktop.status')return{data:status};
    if(action==='windows.private_desktop.windows')return{data:win};
    if(action==='windows.private_desktop.accessibility')return{data:scan};
    throw new Error('UNEXPECTED DEFAULT UI / KEYBOARD / MOUSE '+action);
  };
  const picker=createPrivateFilePickerAdapter(dispatch,()=>0,
    ()=> '11111111-1111-4111-8111-111111111111');
  const request={hwnd:'0xA1',expected_process_id:43123,
    expected_session_id:6,expected_desktop_started_at:status.startedAt,
    filename_edit:{automation_id:'Filename',expected_class:'Edit'},
    confirm_button:{automation_id:'Open',expected_class:'Button'}};
  await picker.prepare(request);
  win.windows[0]!.processId=53123;
  scan.processId=53123;
  await assert.rejects(picker.select({
    grant_id:'11111111-1111-4111-8111-111111111111',
    path:'C:\\Temp\\synthetic.txt',
  }),e=>e instanceof Error&&'code'in e&&e.code==='PICKER_WINDOW_CHANGED');
  assert.equal(calls.filter(s=>/invoke_button|set_edit_value|mouse|keyboard|focus|foreground/i.test(s)).length,0);
  for(const [exe,args] of [
    ['cmd.exe',['/C','call regsvr32.exe /s a.dll']],
    ['powershell.exe',['-Command','New-Object -ComObject Shell.Application']],
    ['cmd.exe',['/C','wsl.exe --exec explorer.exe']],
    ['cmd.exe',['/C','wt.exe -w 0']],
  ] as const)assert.throws(
    ()=>assertNoObviousPrivateShellBrokerInvocation(exe,args),
    e=>e instanceof Error&&'code'in e&&e.code==='AI_PRIVATE_SHELL_BROKER_NOT_ISOLATED',
  );
});
