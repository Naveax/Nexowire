import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {assertIndependentRecoverySigner,startProtectedTransferAndCoreServices,
  type ProtectedTransferServicesStartup} from '../../src/security/protected-transfer-services-startup.js';

// Synthetic keys are only negative/configuration fixtures. They are not
// production issuers, key custody evidence, or permission to execute.
const keyPair=()=>{
  const key=generateKeyPairSync('ed25519');
  return {publicPem:key.publicKey.export({type:'spki',format:'pem'}).toString(),
    privatePem:key.privateKey.export({type:'pkcs8',format:'pem'}).toString()};
};
test('composed CORE/recovery signer separation denies reused SPKI and private observer input',()=>{
  const dispatch=keyPair(),core=keyPair(),helper=keyPair(),recovery=keyPair();
  const config={coreDispatchPrivateKeyPem:dispatch.privatePem,coreObserverPublicKeyPem:core.publicPem,
    helperObserverPublicKeyPem:helper.publicPem,recoveryObserverPublicKeyPem:recovery.publicPem};
  assert.doesNotThrow(()=>assertIndependentRecoverySigner(config));
  for(const key of [dispatch,core,helper])
    assert.throws(()=>assertIndependentRecoverySigner({...config,recoveryObserverPublicKeyPem:key.publicPem}),
      /TRANSFER_RECOVERY_SIGNER_NOT_INDEPENDENT/);
  for(const field of ['recoveryObserverPublicKeyPem','coreObserverPublicKeyPem','helperObserverPublicKeyPem'] as const)
    assert.throws(()=>assertIndependentRecoverySigner({...config,[field]:recovery.privatePem}),
      /TRANSFER_RECOVERY_PUBLIC_KEY_REQUIRED/);
  assert.throws(()=>assertIndependentRecoverySigner({...config,recoveryObserverPublicKeyPem:''}),
    /TRANSFER_RECOVERY_PUBLIC_KEY_REQUIRED/);
});
test('composed production startup denies a shared CORE/recovery key before external authority work',async()=>{
  const id=randomUUID(),ownerId=randomUUID(),deviceId=randomUUID();
  const dispatch=keyPair(),core=keyPair(),helper=keyPair();
  const never=async()=>assert.fail('unexpected external authority work');
  const database={host:'invalid.example',port:5432,database:'fixture',caPem:'fixture'};
  const config={
    core:{authorityId:id,database,port:30100,privateKeyPem:dispatch.privatePem,
      verifyNativeDrain:never,nativeCompletion:{observerPublicKeyPem:core.publicPem,
        evidenceByCapability:{'fixture.process':'JOB_OBJECT_EMPTY'}}},
    transfer:{database,authority:{authorityId:id},server:{authorityId:id,verifyIndependentProvenance:never}},
    selection:{database,authority:{scope:{authorityId:id,ownerId,deviceId},verifyProvenance:never},
      nativeEvidence:{observerPublicKeyPem:helper.publicPem,requestProof:never}},
    rollbackGuard:{observerPublicKeyPem:core.publicPem,requestProof:never},
    transferHost:'127.0.0.1',transferPort:30101,selectionHost:'127.0.0.1',selectionPort:30102,
    startupScope:{ownerId,targetDeviceId:deviceId},verifyTransferRuntimeDrain:never
  } as unknown as ProtectedTransferServicesStartup;
  await assert.rejects(startProtectedTransferAndCoreServices(config),/TRANSFER_RECOVERY_SIGNER_NOT_INDEPENDENT/);
});
