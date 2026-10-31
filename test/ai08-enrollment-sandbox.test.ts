/** AI-08 independent SOURCE-LEVEL adversarial QA.
 * All credentials and owner/device witnesses in this file are synthetic.
 * A PASS is not Windows kernel evidence, enrollment or CORE authorization. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {
  persistentEnrollmentBytes,persistentEnrollmentHash,persistentSessionBytes,
  verifyPersistentEnrollmentSession,
  type PersistentEnrollmentV2,type PersistentSessionV2,
} from '../src/protocol/core-persistent-enrollment-v2.js';
import {
  prepareSandboxRequiredCapability,executeSandboxRequiredCapability,
  SANDBOX_REQUIRED_EFFECT_CAPABILITIES,
} from '../src/agent/task-os-sandbox-capability.js';
import {OsTaskSandboxBlockedError} from '../src/agent/task-os-sandbox-worker.js';

const now=1_800_000_000_000;
function enrollmentFixture(){
  const signingKey=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const spki=signingKey.publicKey.export({format:'der',type:'spki'});
  const grant:PersistentEnrollmentV2={
    version:2,algorithm:'ES256-P1363',scope:'physical-console',
    ownerAccountId:'ai08-owner',ownerSid:'S-1-5-21-100-200-300-1001',
    deviceId:randomUUID(),installationId:randomUUID(),enrollmentId:randomUUID(),
    machineBindingSha256:'a'.repeat(64),
    issuerSpkiSha256:createHash('sha256').update(spki).digest('hex'),
    generation:4,consentedAtMs:now-1000,expiresAt:null,
  };
  const session:PersistentSessionV2={
    version:2,enrollmentSha256:persistentEnrollmentHash(grant),
    nonce:randomUUID(),audience:'nexowire.local-enrollment.session',
    bootId:randomUUID(),windowsSessionId:2,ownerSid:grant.ownerSid,
    logonLuid:'0000000000009876',observedAtMs:now,validUntilMs:now+10000,
  };
  const signature=(bytes:Buffer)=>sign('sha256',bytes,{
    key:signingKey.privateKey,dsaEncoding:'ieee-p1363',
  }).toString('base64');
  return {
    grant:{payload:grant,signatureBase64:signature(persistentEnrollmentBytes(grant))},
    session:{payload:session,signatureBase64:signature(persistentSessionBytes(session))},
    pinnedSpkiDer:spki,nowMs:now+1000,
    expected:{ownerAccountId:grant.ownerAccountId,ownerSid:grant.ownerSid,
      deviceId:grant.deviceId,installationId:grant.installationId,
      machineBindingSha256:grant.machineBindingSha256,enrollmentId:grant.enrollmentId,
      generation:grant.generation,revoked:false,nonce:session.nonce,bootId:session.bootId,
      windowsSessionId:session.windowsSessionId,logonLuid:session.logonLuid},
  };
}

test('AI-08: signed indefinite enrollment is not an effect/dispatch permit',()=>{
  const f=enrollmentFixture();
  const accepted=verifyPersistentEnrollmentSession(f);
  assert.equal(accepted.expiresAt,null);
  assert.equal(accepted.mayDispatch,false);
  assert.ok(Object.isFrozen(accepted));
});

test('AI-08: revoked owner, mismatched machine or session and stale witness deny',()=>{
  const changes=[
    {revoked:true},{ownerAccountId:'foreign-owner'},
    {ownerSid:'S-1-5-18'},{machineBindingSha256:'b'.repeat(64)},
    {deviceId:randomUUID()},{enrollmentId:randomUUID()},
    {bootId:randomUUID()},{nonce:randomUUID()},{generation:5},
  ];
  for(const modification of changes){
    const f=enrollmentFixture();
    Object.assign(f.expected,modification);
    assert.throws(()=>verifyPersistentEnrollmentSession(f),/V2_REJECTED/,
      'must reject '+JSON.stringify(modification));
  }
  for(const offset of [-1_000,11_000]){
    const f=enrollmentFixture();
    f.nowMs=now+offset;
    assert.throws(()=>verifyPersistentEnrollmentSession(f),/V2_REJECTED/);
  }
});

test('AI-08: forged proof cannot activate sandbox or evaluate a hostile getter',async()=>{
  let getterCalls=0,sideEffects=0;
  const input=Object.defineProperty({},'command',{get(){
    getterCalls++;sideEffects++;throw Error('must not read command');
  }});
  const untrusted={signatureValid:true,nativeKernelBoundaryVerified:true,
    descendantsContained:true,networkDenied:true,launchAllowed:true,
    trustedNativeProviderInstalled:true,execute:()=>{sideEffects++;},
    spawn:()=>{sideEffects++;}};
  for(const cap of SANDBOX_REQUIRED_EFFECT_CAPABILITIES){
    const d=prepareSandboxRequiredCapability(cap,input,null,untrusted);
    assert.equal(d.launchAllowed,false,cap);
    assert.equal(d.runtimeIntegratedIntoAgentDispatch,false,cap);
    assert.equal(d.trustedNativeProviderInstalled,false,cap);
    assert.equal(d.mayFallbackToLegacySpawn,false,cap);
    await assert.rejects(executeSandboxRequiredCapability(cap,input,null,untrusted),
      (e:unknown)=>e instanceof OsTaskSandboxBlockedError);
  }
  assert.equal(getterCalls,0);
  assert.equal(sideEffects,0);
});

test('AI-08: UNKNOWN and replay hints cannot authorize process effects',async()=>{
  for(const state of ['unknown','ack_lost','in_progress']){
    const d=prepareSandboxRequiredCapability('shell.exec',{command:'noop'},null,
      {mutationState:state,replayAllowed:true,nativeVerified:true});
    assert.equal(d.state,'RECONCILE_REQUIRED');
    assert.equal(d.canRetryAfterUnknown,false);
    await assert.rejects(executeSandboxRequiredCapability('shell.exec',null,null,
      {mutationState:state}),e=>e instanceof OsTaskSandboxBlockedError &&
        e.code==='OS_TASK_RECONCILIATION_REQUIRED');
  }
});
