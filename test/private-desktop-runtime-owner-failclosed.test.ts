import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {executeWindowsPrivateDesktopCapability as desktop}
  from '../src/agent/windows-private-desktop.js';
import {
  assertNoPrivateDesktopEmergencyStop,
  requireProtectedPrivateDesktopOwner,
  PrivateDesktopRuntimeGateError,
  PRIVATE_DESKTOP_EMERGENCY_STOP_PENDING,
  PRIVATE_DESKTOP_OWNER_WITNESS_UNAVAILABLE,
} from '../src/agent/private-desktop-runtime-owner-gate.js';
import {
  type PrivateDesktopLaunchIdentity,
  type PrivateDesktopKernelWitness,
} from '../src/agent/private-desktop-owner-fence.js';

const check=(code:string)=>(e:unknown)=>
  e instanceof PrivateDesktopRuntimeGateError&&e.code===code;
const stored={
  version:1,desktopName:'NexowirePrivate',hostPid:2147483600,
  shellPid:2147483601,launchedPids:[2147483602],
  startedAt:'2026-10-21T20:00:00.000Z',
};
async function fixture(t:test.TestContext):Promise<string>{
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'nx09-owner-runtime-'));
  const previous=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=tmp;
  t.after(async()=>{
    if(previous===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=previous;
    await fs.rm(tmp,{recursive:true,force:true});
  });
  await fs.writeFile(path.join(tmp,'state.json'),JSON.stringify(stored));
  return tmp;
}
test('real desktop STOP persists cancellation but never taskkills forged state PIDs',{
  skip:process.platform!=='win32',
},async t=>{
  const root=await fixture(t);
  // Never spawn or address a real process; stored PIDs are inert fixtures.
  await assert.rejects(desktop('windows.private_desktop.stop',{}),
    check(PRIVATE_DESKTOP_OWNER_WITNESS_UNAVAILABLE));
  assert.match(await fs.readFile(path.join(root,'emergency-stop.pending'),'utf8'),
    /STOP_REQUESTED/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'state.json'),'utf8')),stored);
  // A second emergency-stop request cannot turn an unverified PID into a
  // fake reported success or remove the cancellation record.
  await assert.rejects(desktop('windows.private_desktop.stop',{}),
    check(PRIVATE_DESKTOP_OWNER_WITNESS_UNAVAILABLE));
  assert.ok((await fs.stat(path.join(root,'state.json'))).isFile());
});
test('pending emergency stop rejects child/COM/picker/focus/keyboard and restart',{
  skip:process.platform!=='win32',
},async t=>{
  const root=await fixture(t);
  await assert.rejects(desktop('windows.private_desktop.stop',{}),
    check(PRIVATE_DESKTOP_OWNER_WITNESS_UNAVAILABLE));
  for(const [name,payload] of [
    ['windows.private_desktop.launch',{executable:'notepad.exe'}],
    ['windows.private_desktop.start',{create_shortcut:false}],
    ['windows.private_desktop.accessibility.invoke_button',{
      hwnd:'0x111',automation_id:'Open',expected_class:'Button',
    }],
    ['windows.private_desktop.accessibility.set_edit_value',{
      hwnd:'0x111',automation_id:'FileName',expected_class:'Edit',value:'fake'},
    ],
    ['windows.private_keyboard.type',{hwnd:'0x111',text:'NEVER_TYPE'}],
    ['windows.private_pointer.click',{hwnd:'0x111',x:2,y:2}],
    ['windows.private_desktop.window.close',{hwnd:'0x111'}],
  ] as const){
    await assert.rejects(desktop(name,payload),
      check(PRIVATE_DESKTOP_EMERGENCY_STOP_PENDING),
      'Unverified action must not enter Windows GUI/COM/native path: '+name);
  }
  await assert.rejects(assertNoPrivateDesktopEmergencyStop(root),
    check(PRIVATE_DESKTOP_EMERGENCY_STOP_PENDING));
});
test('corrupt state on emergency stop still records cancellation before failing',{
  skip:process.platform!=='win32',
},async t=>{
  const root=await fixture(t);
  await fs.writeFile(path.join(root,'state.json'),'{broken json');
  await assert.rejects(desktop('windows.private_desktop.stop',{}),
    e=>e instanceof Error&&'code'in e&&e.code==='PRIVATE_DESKTOP_STATE_INVALID');
  assert.match(await fs.readFile(path.join(root,'emergency-stop.pending'),'utf8'),
    /STOP_REQUESTED/);
  await assert.rejects(desktop('windows.private_keyboard.type',{
    hwnd:'0x1',text:'NEVER_TYPE',
  }),check(PRIVATE_DESKTOP_EMERGENCY_STOP_PENDING));
});
test('replaced emergency marker cannot redirect writes or authorize PID stop',{
  skip:process.platform!=='win32',
},async t=>{
  const root=await fixture(t);
  await fs.mkdir(path.join(root,'emergency-stop.pending'));
  await assert.rejects(desktop('windows.private_desktop.stop',{}),
    check(PRIVATE_DESKTOP_EMERGENCY_STOP_PENDING));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'state.json'),'utf8')),stored);
});
test('forged launchedPids cannot authorize a new private GUI child before OS proof',{
  skip:process.platform!=='win32',
},async t=>{
  const root=await fixture(t);
  assert.equal(await fs.access(path.join(root,'emergency-stop.pending'))
    .then(()=>true,()=>false),false);
  await assert.rejects(desktop('windows.private_desktop.launch',{
    executable:'notepad.exe',args:[],
  }),check(PRIVATE_DESKTOP_OWNER_WITNESS_UNAVAILABLE));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'state.json'),'utf8')),stored);
});
test('even a valid synthetic protected witness returns inert proof only',async()=>{
  const owner:PrivateDesktopLaunchIdentity={
    pid:42001,creationTime100ns:'134059294000000000',sessionId:7,
    desktopGeneration:'desktop-owner-instance-20261021',
    ownerEpoch:4,guardianPid:42000,
    guardianCreationTime100ns:'134059293000000000',
    jobHandleId:'guardian-kernel-job-17',cancelEpoch:3,
  };
  const witness:PrivateDesktopKernelWitness={
    processPid:owner.pid,processCreationTime100ns:owner.creationTime100ns,
    processSessionId:owner.sessionId,processDesktopName:'NexowirePrivate',
    guardianPid:owner.guardianPid,
    guardianCreationTime100ns:owner.guardianCreationTime100ns,
    jobHandleId:owner.jobHandleId,isMemberOfGuardianJob:true,
    guardianJobVerified:true,collectorVerified:true,
    ownerEpoch:owner.ownerEpoch,desktopGeneration:owner.desktopGeneration,
    cancelEpoch:owner.cancelEpoch,inputDesktop:'Default',processState:'running',
  };
  await assert.rejects(requireProtectedPrivateDesktopOwner('stop'),
    check(PRIVATE_DESKTOP_OWNER_WITNESS_UNAVAILABLE));
  let reads=0;
  const proof=await requireProtectedPrivateDesktopOwner(
    'launch',owner,async()=>{reads++;return witness;},
  );
  assert.equal(reads,2);
  assert.deepEqual(proof,{
    pid:owner.pid,creationTime100ns:owner.creationTime100ns,
  });
  assert.ok(Object.isFrozen(proof));
  assert.equal('processHandle'in proof,false);
  assert.equal('uacApprove'in proof,false);
});
test('private dispatch cannot accept remote "signed" or "CORE" overrides',{
  skip:process.platform!=='win32',
},async t=>{
  await fixture(t);
  // Malicious JSON can claim CORE, high token, guardian and signed publisher.
  // Production route ignores those claims until #03 native collector exists.
  await assert.rejects(desktop('windows.private_desktop.launch',{
    executable:'notepad.exe',args:[],
    ownerProof:{collectorVerified:true,guardianJobVerified:true,
      highToken:true,signedPublisher:true},
  }),check(PRIVATE_DESKTOP_OWNER_WITNESS_UNAVAILABLE));
});
