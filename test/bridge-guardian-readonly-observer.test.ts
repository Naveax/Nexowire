import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessBridgeGuardianReadOnlyInventory,
} from '../src/agent/bridge-guardian-readonly-observer.js';
import {
  BRIDGE_GUARDIAN_TASK_NAME,
  BRIDGE_GUARDIAN_POWERSHELL,
  BRIDGE_GUARDIAN_LAUNCHER,
  BRIDGE_GUARDIAN_SOURCE_ROOT,
} from '../src/agent/bridge-guardian-task-preflight.js';

const sid='S-1-5-21-100-200-300-1001';
const record = (status:'ABSENT'|'AMBIGUOUS'|'UNVERIFIED'|'SNAPSHOT_ONLY') => ({
  auditOnly:true,
  privilegedOperationPerformed:false,
  installed:status==='SNAPSHOT_ONLY',
  lookupVerified:status==='ABSENT'||status==='SNAPSHOT_ONLY',
  status,currentUserSid:sid,
  snapshot:status==='SNAPSHOT_ONLY'?{
    name:BRIDGE_GUARDIAN_TASK_NAME,
    taskPath:'\\',state:'Running',
    principal:{userSid:sid,runLevel:'Highest',logonType:'Interactive'},
    actions:[{
      execute:BRIDGE_GUARDIAN_POWERSHELL,
      arguments:'-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+BRIDGE_GUARDIAN_LAUNCHER+'"',
      workingDirectory:BRIDGE_GUARDIAN_SOURCE_ROOT,
    }],
    triggers:[{type:'Logon',userSid:sid,enabled:true}],
  }:null,
});
const inspect=(data:unknown,verifyProtectedSource:()=>void=()=>{})=>
  assessBridgeGuardianReadOnlyInventory(JSON.stringify(data),{
    expectedUserSid:sid,verifyProtectedSource,
  });

test('absent, ambiguous and inaccessible task states do not infer Guardian readiness',()=>{
  for(const state of ['ABSENT','AMBIGUOUS','UNVERIFIED'] as const){
    let checks=0;
    const observed=inspect(record(state),()=>{checks++});
    assert.equal(observed.status,state==='ABSENT'?'absent':'unverified');
    assert.equal(observed.taskIdentityVerified,false);
    assert.equal(observed.sourceAclVerified,false);
    assert.equal(observed.hubChannelVerified,false);
    assert.equal(observed.remoteActuationAuthorized,false);
    assert.equal(checks,0);
  }
});

test('even canonical running task with protected launcher remains NOT authorized for remote OS action',()=>{
  const out=inspect(record('SNAPSHOT_ONLY'));
  assert.deepEqual(out,{
    status:'source-acl-verified',
    taskIdentityVerified:true,sourceAclVerified:true,
    hubChannelVerified:false,remoteActuationAuthorized:false,
  });
  assert.equal(Object.isFrozen(out),true);
});

test('ACL failure degrades to identity-only, never a trusted Guardian',()=>{
  const obs=inspect(record('SNAPSHOT_ONLY'),()=>{
    throw new Error('PROTECTED_ACL_INTEGRITY_FAILURE');
  });
  assert.equal(obs.status,'task-identity-only');
  assert.equal(obs.taskIdentityVerified,true);
  assert.equal(obs.sourceAclVerified,false);
  assert.equal(obs.remoteActuationAuthorized,false);
});

test('forged Scheduled Task action cannot trigger even a read-only ACL verification',()=>{
  let invoked=false;
  const task=record('SNAPSHOT_ONLY');
  const forged={...task,snapshot:{
    ...task.snapshot,
    actions:[{...task.snapshot!.actions[0],arguments:'-EncodedCommand ATTACK'}],
  }};
  const obs=inspect(forged,()=>{invoked=true});
  assert.equal(obs.status,'untrusted-task');
  assert.equal(invoked,false);
  assert.equal(obs.remoteActuationAuthorized,false);
});

test('schema rejects inconsistent, oversized, wrong-user or caller-forged audit status',()=>{
  const invalid=[
    {...record('ABSENT'),installed:true},
    {...record('ABSENT'),snapshot:{evil:true}},
    {...record('UNVERIFIED'),lookupVerified:true},
    {...record('AMBIGUOUS'),lookupVerified:true},
    {...record('SNAPSHOT_ONLY'),installed:false},
    {...record('SNAPSHOT_ONLY'),lookupVerified:false},
    {...record('ABSENT'),auditOnly:false},
    {...record('ABSENT'),privilegedOperationPerformed:true},
    {...record('ABSENT'),currentUserSid:'S-1-5-18'},
    {...record('ABSENT'),status:'READY'},
    {...record('ABSENT'),executeTask:true},
  ];
  for(const item of invalid){
    assert.throws(()=>inspect(item));
  }
  assert.throws(
    ()=>assessBridgeGuardianReadOnlyInventory('{ broken',{
      expectedUserSid:sid,verifyProtectedSource:()=>{},
    }),
    /BRIDGE_GUARDIAN_INVENTORY_INVALID_JSON/,
  );
  assert.throws(
    ()=>assessBridgeGuardianReadOnlyInventory('X'.repeat(65537),{
      expectedUserSid:sid,verifyProtectedSource:()=>{},
    }),
    /BRIDGE_GUARDIAN_INVENTORY_TOO_LARGE_OR_EMPTY/,
  );
});
