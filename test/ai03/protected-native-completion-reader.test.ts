import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {ProtectedNativeCompletionReader,type NativeCompletionClaim,type NativeEffectCompletionProof}
  from '../../src/agent/protected-native-completion-reader.js';
test('native completion reader denies tamper, wrong observer, scope, and wrong evidence kind',()=>{
  const observer=generateKeyPairSync('ed25519'),other=generateKeyPairSync('ed25519');
  const reader=new ProtectedNativeCompletionReader({
    observerPublicKeyPem:observer.publicKey.export({type:'spki',format:'pem'}).toString(),
    evidenceByCapability:{'fixture.process':'JOB_OBJECT_EMPTY'}});
  const now=Date.now(),claim:NativeCompletionClaim={authorityId:randomUUID(),dispatchId:randomUUID(),
    brokerId:randomUUID(),commitNonce:'a'.repeat(64),reservedAtMs:now-100,
    request:{requestId:randomUUID(),capability:'fixture.process',fingerprint:'b'.repeat(64),
      scope:{ownerId:randomUUID(),deviceId:randomUUID(),deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),
        ownerEpoch:2,expectedGeneration:3,requiredPrivilege:'CORE'}}};
  const p:NativeEffectCompletionProof={version:1,kind:'core_native_effect_completion_v1',
    authorityId:claim.authorityId,dispatchId:claim.dispatchId,brokerId:claim.brokerId,commitNonce:claim.commitNonce,
    request:claim.request,outcome:'TERMINAL_DRAINED',evidenceKind:'JOB_OBJECT_EMPTY',
    evidenceSha256:'c'.repeat(64),completedAtMs:now};
  const signed=(value:unknown,key=observer.privateKey)=>{
    const bytes=Buffer.from(JSON.stringify(value));return [bytes.toString('base64url'),sign(null,bytes,key).toString('base64url')] as const;
  };
  assert.equal(reader.verifyRecord(...signed(p),claim,now),true);
  assert.equal(reader.verifyRecord(...signed(p,other.privateKey),claim,now),false);
  for(const bad of [{...p,commitNonce:'f'.repeat(64)},{...p,dispatchId:randomUUID()},
    {...p,request:{...p.request,fingerprint:'f'.repeat(64)}},{...p,evidenceKind:'NATIVE_OPERATION_TERMINAL'},
    {...p,completedAtMs:now+1},{...p,completedAtMs:claim.reservedAtMs-1}]){
    assert.equal(reader.verifyRecord(...signed(bad),claim,now),false);
  }
  const [payload,sig]=signed(p);
  assert.equal(reader.verifyRecord(payload+'A',sig,claim,now),false);
});
