import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  reserveVerifiedGuardianCommand,
  type BridgeGuardianTrustedFacts,
} from '../src/agent/bridge-guardian-policy.js';
import {
  assertNoPrivateDesktopBrokeredExecutable,
  assertNoPrivateDesktopOpaqueLauncher,
} from '../src/agent/windows-private-desktop.js';
import {assertNoObviousPrivateShellBrokerInvocation}
  from '../src/agent/windows-private-shell-broker-guard.js';
import {createPrivateFilePickerAdapter}
  from '../src/agent/windows-private-file-picker.js';

const requestId='11111111-1111-4111-8111-111111111111';
const stamp='2026-10-21T12:00:00.000Z';
const intent={
  type:'admin-bridge.mode-intent',version:1,requestId,deviceId:'fixture-device',
  ownerAccountId:'fixture-owner',credentialBinding:'a'.repeat(64),
  desiredMode:'on' as const,
  issuedAt:'2026-10-21T11:59:50.000Z',
  expiresAt:'2026-10-21T12:01:30.000Z',
};
const trusted=():BridgeGuardianTrustedFacts=>({
  deviceId:intent.deviceId,ownerAccountId:intent.ownerAccountId,
  credentialBinding:intent.credentialBinding,
  platform:'win32',accessMode:'full',
  currentPreference:{desiredMode:'on',revision:'fixture-revision'},
  ownerApproval:{requestId,preferenceRevision:'fixture-revision'},
  localGuardian:{
    installed:true,online:true,independentlyReachableWithBrokerOff:true,
    protectedSourceVerified:true,taskIdentityVerified:true,
    elevatedLocalTokenVerified:true,hubTransportAuthenticated:true,
    currentDeviceSessionVerified:true,
  },
  broker:{canonicalTaskIdentityVerified:true,launcherAclVerified:true},
  now:new Date(stamp),
});
const code=(value:string)=>(error:unknown)=>
  error instanceof Error&&'code'in error&&error.code===value;

test('FULL/CORE preference never authorizes an unverified elevated Broker',async()=>{
  for(const change of [
    (v:BridgeGuardianTrustedFacts)=>({...v,
      broker:{...v.broker,canonicalTaskIdentityVerified:false}}),
    (v:BridgeGuardianTrustedFacts)=>({...v,
      broker:{...v.broker,launcherAclVerified:false}}),
    (v:BridgeGuardianTrustedFacts)=>({...v,
      localGuardian:{...v.localGuardian,protectedSourceVerified:false}}),
    (v:BridgeGuardianTrustedFacts)=>({...v,
      localGuardian:{...v.localGuardian,elevatedLocalTokenVerified:false}}),
    (v:BridgeGuardianTrustedFacts)=>({...v,
      localGuardian:{...v.localGuardian,currentDeviceSessionVerified:false}}),
    (v:BridgeGuardianTrustedFacts)=>({...v,accessMode:'safe' as const}),
  ]){
    let reserved=0;
    const mutated=change(trusted());
    await assert.rejects(
      reserveVerifiedGuardianCommand(intent,async()=>mutated,
        async()=>{reserved++;return true;}),
    );
    assert.equal(reserved,0,'invalid trust facts must fail before reservation');
  }
});

test('verified guardian creates only reserved intent, not GUI/UAC execution power',async()=>{
  let reserved=0;
  const result=await reserveVerifiedGuardianCommand(intent,
    async()=>trusted(),async()=>{reserved++;return true;});
  assert.equal(reserved,1);
  assert.equal(result.state,'reserved-for-verified-local-processing');
  assert.equal('pid'in result,false);
  assert.equal('executable'in result,false);
  assert.equal('shell'in result,false);
  assert.equal('uacApprove'in result,false);
});

test('private GUI cannot borrow trusted CORE Broker path to click UAC or launch DLL/COM',()=>{
  for(const exe of ['runas.exe','regsvr32.exe','schtasks.exe','explorer.exe']){
    assert.throws(()=>assertNoPrivateDesktopBrokeredExecutable(exe),
      code('PRIVATE_DESKTOP_SHELL_BROKER_UNISOLATED'));
  }
  for(const [exe,args] of [
    ['cmd.exe',['/C','start "" consent.exe']],
    ['powershell.exe',['-Command','Start-Process calc -Verb RunAs']],
    ['cmd.exe',['/C','call regsvr32.exe /s demo.dll']],
    ['powershell.exe',['-Command','New-Object -ComObject Shell.Application']],
    ['cmd.exe',['/C','wsl.exe --exec explorer.exe']],
    ['cmd.exe',['/C','wt.exe -w 0']],
  ] as const){
    assert.throws(()=>assertNoObviousPrivateShellBrokerInvocation(exe,args),
      code('AI_PRIVATE_SHELL_BROKER_NOT_ISOLATED'));
  }
  assert.throws(()=>assertNoPrivateDesktopOpaqueLauncher('powershell.exe',
    ['-NoProfile','-Command','Start-Process calc -Verb RunAs']),
    code('PRIVATE_DESKTOP_OPAQUE_WRAPPER_UNISOLATED'));
});

test('input-desktop UAC and emergency stop after grant reject foreign Explorer HWND',async()=>{
  const now='2026-10-21T12:00:00.000Z',grant='22222222-2222-4222-8222-222222222222';
  const status={
    running:true,desktopName:'NexowirePrivate',inputDesktop:'Default',
    startedAt:now,launchedPids:[40201],
  };
  const windows={inputDesktop:'Default',
    windows:[{hwnd:'0xABC',processId:40201,title:'Synthetic Open'}]};
  const nodes=[
    {processId:40201,controlType:'ControlType.Edit',automationId:'Filename',
     className:'Edit',enabled:true,offscreen:false,
     rect:{left:1,top:2,width:200,height:20}},
    {processId:40201,controlType:'ControlType.Button',automationId:'Open',
     className:'Button',enabled:true,offscreen:false,
     rect:{left:210,top:2,width:40,height:20}},
  ];
  const scan={hwnd:'0xABC',processId:40201,sessionId:8,inputDesktop:'Default',
    skipped:0,truncated:false,foreignProcessNodesSkipped:0,nodes};
  const sent:string[]=[];
  const dispatch=async(action:string)=>{
    sent.push(action);
    if(action==='windows.private_desktop.status')return{data:status};
    if(action==='windows.private_desktop.windows')return{data:windows};
    if(action==='windows.private_desktop.accessibility')return{data:scan};
    throw new Error('Unexpected UIA/focus/keyboard/mouse dispatch: '+action);
  };
  const a=createPrivateFilePickerAdapter(dispatch,()=>0,()=>grant);
  const target={hwnd:'0xABC',expected_process_id:40201,expected_session_id:8,
    expected_desktop_started_at:now,
    filename_edit:{automation_id:'Filename',expected_class:'Edit'},
    confirm_button:{automation_id:'Open',expected_class:'Button'}};
  await a.prepare(target);
  windows.windows[0]!.processId=40202;
  status.inputDesktop='Winlogon';
  status.running=false;
  await assert.rejects(a.select({grant_id:grant,path:'C:\\Temp\\fixture.txt'}),
    code('PICKER_DESKTOP_UNSAFE'));
  assert.equal(sent.filter(v=>/invoke|set_edit_value|keyboard|mouse|foreground/i.test(v)).length,0);
  await assert.rejects(a.select({grant_id:grant,path:'C:\\Temp\\fixture.txt'}),
    code('PICKER_GRANT_INVALID'));
});

test('no private desktop CORE runtime route exists to privileged broker or physical GUI',async()=>{
  const source=await readFile(new URL('../src/agent/windows-private-desktop.ts',import.meta.url),'utf8');
  const gui=source.match(/async function launch\([\s\S]*?(?=async function stop\()/)?.[0]??'';
  assert.ok(gui.includes('assertNoPrivateDesktopBrokeredExecutable'));
  assert.ok(gui.includes('assertNoPrivateDesktopOpaqueLauncher'));
  assert.doesNotMatch(gui,/PrivilegedBrokerClient|reserveVerifiedGuardianCommand|\bconsent\.exe\b|SetForegroundWindow|SwitchDesktop/);
});
