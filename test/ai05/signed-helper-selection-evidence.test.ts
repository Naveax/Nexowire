import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {createSignedHelperSelectionEvidenceVerifier,helperEvidenceRequiredFacts,type HelperEvidenceChallenge} from '../../src/security/signed-helper-selection-evidence.js';
import type {HelperAuthorityEvidenceRequest} from '../../src/security/postgres-helper-selection-authority.js';
const signer=generateKeyPairSync('ed25519'),other=generateKeyPairSync('ed25519');
const pub=signer.publicKey.export({type:'spki',format:'pem'}).toString();
const observation:HelperAuthorityEvidenceRequest={
  phase:'RELEASE',scope:{authorityId:randomUUID(),deviceId:randomUUID(),ownerId:randomUUID(),deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),ownerEpoch:1,generation:1,brokerId:randomUUID()},
  lease:{id:randomUUID(),requestId:randomUUID(),kind:'RUNTIME',expectedRevision:randomUUID()},
  selection:{revision:randomUUID(),pin:null},
};
function answer(c:HelperEvidenceChallenge,changes:Record<string,unknown>={},key=signer.privateKey){
  const observedAt=Date.now(),payload=JSON.stringify({...c,accepted:true,facts:helperEvidenceRequiredFacts(c.phase),observedAt,expiresAt:observedAt+1000,...changes});
  return {payload,proof:sign(null,Buffer.from(payload,'utf8'),key).toString('base64url')};
}
test('signed native evidence accepts only an exact fresh independent challenge and facts',async()=>{
  const verify=createSignedHelperSelectionEvidenceVerifier({observerPublicKeyPem:pub,async requestProof(c){return answer(c);}});
  assert.equal(await verify(observation),true);
  for(const changes of [{nonce:'0'.repeat(64)},{requestSha256:'0'.repeat(64)},{phase:'READ'},{accepted:false},{facts:['exact-lease']},{expiresAt:Date.now()-1000}]){
    const denied=createSignedHelperSelectionEvidenceVerifier({observerPublicKeyPem:pub,async requestProof(c){return answer(c,changes);}});
    assert.equal(await denied(observation),false);
  }
});
test('signed native evidence denies foreign signer, replayed reply and unavailable observer',async()=>{
  const wrong=createSignedHelperSelectionEvidenceVerifier({observerPublicKeyPem:pub,async requestProof(c){return answer(c,{},other.privateKey);}});
  assert.equal(await wrong(observation),false);
  let previous:ReturnType<typeof answer>|undefined;
  const replay=createSignedHelperSelectionEvidenceVerifier({observerPublicKeyPem:pub,async requestProof(c){return previous??=answer(c);}});
  assert.equal(await replay(observation),true);assert.equal(await replay(observation),false);
  const unavailable=createSignedHelperSelectionEvidenceVerifier({observerPublicKeyPem:pub,timeoutMs:250,async requestProof(){return new Promise(()=>{});}});
  assert.equal(await unavailable(observation),false);
});
