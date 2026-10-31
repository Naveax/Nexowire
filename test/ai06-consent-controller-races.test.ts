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
