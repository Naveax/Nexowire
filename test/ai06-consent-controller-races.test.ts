import test from 'node:test';
import assert from 'node:assert/strict';
import {CoreConsoleAdmission,type CoreConsoleNativeProvider} from '../src/agent/core-console-admission.js';

// Synthetic controller/provider interface only. No installed native consent,
// Windows effect, OS approval, UAC or production D1 service in these tests.
const binding={ownerAccountId:'ai06-owner-scope',deviceId:'ai06-device-scope',
  installationId:'ai06-install-scope'};

function deferred<T>(){
  let entered!:()=>void,finish!:(value:T)=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const result=new Promise<T>(resolve=>{finish=resolve;});
  return {started,finish,wait:async()=>{entered();return result;}};
}
for(const revokeFails of [false,true])test(
  'AI-06: controller STOP wins against delayed enrollment approval, revoke fails='+revokeFails,
  async()=>{
    const approval=deferred<boolean>();let revokes=0,effects=0;
    const provider:CoreConsoleNativeProvider={
      binding,
      enroll:async()=>approval.wait(),
      revoke:async()=>{revokes++;if(revokeFails)throw new Error('REMOTE_REVOKE_ACK_LOST');},
      inspect:async()=>{throw new Error('NOT_A_PHYSICAL_PROVIDER');},
      execute:async()=>{effects++;throw new Error('UNEXPECTED_NATIVE_DISPATCH');},
    };
    const controller=new CoreConsoleAdmission(undefined,provider);
    const pending=controller.enroll(new AbortController().signal);
    await approval.started;
    if(revokeFails)await assert.rejects(controller.revoke(),/REMOTE_REVOKE_ACK_LOST/);
    else await controller.revoke();
    approval.finish(true);
    await assert.rejects(pending,(error:unknown)=>
      !!error&&typeof error==='object'&&'code' in error&&
      error.code==='CORE_ENROLLMENT_REVOKED_DURING_APPROVAL');
    assert.equal(revokes,1);
    assert.equal((await controller.status('full')).state,'REVOKED_LOCALLY');
    await assert.rejects(controller.execute('windows.pointer.click',{},
      '00000000-0000-4000-8000-000000000001','full'));
    assert.equal(effects,0);
});

test('AI-06: a new explicit enrollment after completed STOP may reopen the controller',async()=>{
  let approved=0;
  const provider:CoreConsoleNativeProvider={
    binding,
    enroll:async()=>{approved++;return true;},
    revoke:async()=>{},
    inspect:async()=>{throw new Error('SYNTHETIC_NATIVE_PROOF_UNAVAILABLE');},
    execute:async()=>{throw new Error('UNEXPECTED_NATIVE_DISPATCH');},
  };
  const controller=new CoreConsoleAdmission(undefined,provider);
  await controller.revoke();
  assert.equal((await controller.status('full')).state,'REVOKED_LOCALLY');
  const success=await controller.enroll(new AbortController().signal);
  assert.equal(success,true,'only a new explicit local enrollment may clear STOP');
  assert.equal(approved,1);
  const status=await controller.status('full');
  assert.equal(status.active,false,'synthetic provider is not real OS approval');
  assert.equal(status.state,'CURRENT_AUTHORITY_UNAVAILABLE');
});

test('AI-06: close during delayed enrollment permanently fences controller approval',async()=>{
  const approval=deferred<boolean>();let closes=0,starts=0,effects=0;
  const provider:CoreConsoleNativeProvider={
    binding,
    enroll:async()=>{starts++;return approval.wait();},
    revoke:async()=>{},
    close:()=>{closes++;},
    inspect:async()=>{throw new Error('NO_NATIVE_OS_READBACK');},
    execute:async()=>{effects++;throw new Error('UNEXPECTED_NATIVE_DISPATCH');},
  };
  const controller=new CoreConsoleAdmission(undefined,provider);
  const pending=controller.enroll(new AbortController().signal);
  await approval.started;
  controller.close();
  approval.finish(true);
  await assert.rejects(pending,(error:unknown)=>
    !!error&&typeof error==='object'&&'code' in error&&
    error.code==='CORE_CONSOLE_CONTROLLER_CLOSED');
  assert.equal((await controller.status('full')).state,'REVOKED_LOCALLY');
  await assert.rejects(controller.enroll(new AbortController().signal),/CORE_CONSOLE_CONTROLLER_CLOSED/);
  await assert.rejects(controller.execute('windows.pointer.click',{},
    '00000000-0000-4000-8000-000000000077','full'));
  controller.close();
  assert.equal(closes,1,'repeated close is idempotent');
  assert.equal(starts,1,'close cannot start another approval');
  assert.equal(effects,0);
});

test('AI-06: parallel controller enrollment requests cannot start two approval prompts',async()=>{
  const approval=deferred<boolean>();let starts=0;
  const provider:CoreConsoleNativeProvider={
    binding,
    enroll:async()=>{starts++;return approval.wait();},
    revoke:async()=>{},
    inspect:async()=>{throw new Error('SYNTHETIC_READBACK_NOT_NATIVE');},
    execute:async()=>{throw new Error('UNEXPECTED_NATIVE_DISPATCH');},
  };
  const controller=new CoreConsoleAdmission(undefined,provider);
  const first=controller.enroll(new AbortController().signal);
  await approval.started;
  await assert.rejects(controller.enroll(new AbortController().signal),
    /CORE_ENROLLMENT_PROMPT_ACTIVE/);
  assert.equal(starts,1,'only one native approval workflow can be active');
  approval.finish(true);
  assert.equal(await first,true);
  const status=await controller.status('full');
  assert.equal(status.active,false,'synthetic provider is not real protected OS readback');
  assert.equal(status.state,'CURRENT_AUTHORITY_UNAVAILABLE');
});

test('AI-06: enrollment cannot run while previous remote revoke ACK is unresolved',async()=>{
  const gate=deferred<void>();let approvals=0;
  const provider:CoreConsoleNativeProvider={
    binding,
    enroll:async()=>{approvals++;return true;},
    revoke:async()=>gate.wait(),
    inspect:async()=>{throw new Error('NO_PROTECTED_OS_PROOF');},
    execute:async()=>{throw new Error('NO_EFFECT');},
  };
  const controller=new CoreConsoleAdmission(undefined,provider);
  const pending=controller.revoke();
  await gate.started;
  await assert.rejects(controller.enroll(new AbortController().signal),
    /CORE_ENROLLMENT_REVOKE_IN_PROGRESS/);
  assert.equal(approvals,0,'in-progress revoke must block even a new local prompt');
  assert.equal((await controller.status('full')).state,'REVOKED_LOCALLY');
  gate.finish();
  await pending;
  assert.equal(await controller.enroll(new AbortController().signal),true,
    'a fresh enrollment may start only after confirmed revoke completion');
  assert.equal(approvals,1);
  assert.equal((await controller.status('full')).active,false,
    'a synthetic provider is not physical OS consent');
});

test('AI-06: lost revoke ACK denies enrollment until later confirmed revoke',async()=>{
  let attempts=0,approvals=0,effects=0;
  const provider:CoreConsoleNativeProvider={
    binding,
    enroll:async()=>{approvals++;return true;},
    revoke:async()=>{attempts++;if(attempts===1)throw new Error('REMOTE_ACK_LOST');},
    inspect:async()=>{throw new Error('NO_PROTECTED_OS_PROOF');},
    execute:async()=>{effects++;throw new Error('NO_EFFECT');},
  };
  const controller=new CoreConsoleAdmission(undefined,provider);
  await assert.rejects(controller.revoke(),/REMOTE_ACK_LOST/);
  await assert.rejects(controller.enroll(new AbortController().signal),
    /CORE_ENROLLMENT_REVOKE_UNCERTAIN/);
  assert.equal(approvals,0);
  assert.equal((await controller.status('full')).state,'REVOKED_LOCALLY');
  await controller.revoke();
  assert.equal(attempts,2);
  assert.equal(await controller.enroll(new AbortController().signal),true,
    'only a later successful revoke permits a fresh explicit enrollment');
  assert.equal(approvals,1);
  assert.equal(effects,0);
  assert.equal((await controller.status('full')).active,false);
});
