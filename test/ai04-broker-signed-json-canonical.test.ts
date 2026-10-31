/** AI-04: test-only Ed25519/CAS, never independent production authority. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {BrokerExternalDispatchFence,
  type BrokerDispatchRequest,type ProtectedBrokerEvidence,
  type ExternalBrokerDispatchAuthority,type DispatchClaim,
} from '../src/agent/broker-external-dispatch-fence.js';

const keys=generateKeyPairSync('ed25519');
const publicKeyPem=keys.publicKey.export({type:'spki',format:'pem'}).toString();
type Stage='reserve'|'commit';
type Variant='whitespace'|'duplicate-key'|'escaped-value'|'invalid-utf8';
function signBytes(bytes:Buffer):DispatchClaim {
  return {payload:bytes.toString('base64url'),
    signature:sign(null,bytes,keys.privateKey).toString('base64url')};
}
function variantBytes(raw:string,variant:Variant):Buffer {
  if(variant==='whitespace')return Buffer.from(' '+raw,'utf8');
  if(variant==='duplicate-key'){
    assert.ok(raw.includes('"ownerEpoch":4'));
    return Buffer.from(raw.replace('"ownerEpoch":4',
      '"ownerEpoch":4,"ownerEpoch":4'),'utf8');
  }
  if(variant==='escaped-value'){
    assert.ok(raw.includes('shell.exec'));
    return Buffer.from(raw.replace('shell.exec','shell\\u002eexec'),'utf8');
  }
  const b=Buffer.from(raw,'utf8');
  return Buffer.concat([b.subarray(0,b.length-1),Buffer.from([0xff]),
    b.subarray(b.length-1)]);
}
function fixture(tamper?:{stage:Stage;variant:Variant}){
  const authorityId=randomUUID(),brokerId=randomUUID(),dispatchId=randomUUID();
  const scope={ownerId:randomUUID(),deviceId:randomUUID(),
    deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),ownerEpoch:4,
    expectedGeneration:7,requiredPrivilege:'CORE' as const};
  const request:BrokerDispatchRequest={requestId:randomUUID(),
    fingerprint:'d'.repeat(64),capability:'shell.exec',scope};
  const broker:ProtectedBrokerEvidence={
    verified:true,brokerId,ownerEpoch:4,grantGeneration:7,
    highIntegrityToken:true,signedProtectedImage:true,
    protectedParentAndImports:true};
  const counts={begin:0,commit:0,release:0};
  function receipt(stage:Stage,nonce:string):DispatchClaim {
    const now=Date.now();
    const value={kind:stage==='reserve'?'broker_dispatch_permit_v1':
      'broker_dispatch_commit_v1',authorityId,brokerId,dispatchId,
      challengeNonce:nonce,requestId:request.requestId,
      fingerprint:request.fingerprint,capability:request.capability,
      ownerId:scope.ownerId,deviceId:scope.deviceId,
      deviceEpoch:scope.deviceEpoch,sessionEpoch:scope.sessionEpoch,
      ownerEpoch:4,generation:7,privilege:'CORE',
      issuedAtMs:now,expiresAtMs:now+2000};
    const json=JSON.stringify(value);
    return signBytes(tamper?.stage===stage?
      variantBytes(json,tamper.variant):Buffer.from(json,'utf8'));
  }
  const authority:ExternalBrokerDispatchAuthority={
    async beginIfCurrent(_req,_broker,nonce){counts.begin++;return receipt('reserve',nonce)},
    async commitIfCurrent(_req,_broker,_id,nonce){counts.commit++;return receipt('commit',nonce)},
    async release(){counts.release++},
    async revokeAndDrain(){throw Error('TEST_ONLY_NO_REVOKE')},
  };
  const gate=new BrokerExternalDispatchFence({authority,authorityId,publicKeyPem,
    verifyIdentity:async()=>true,
    verifyEffectiveBroker:async()=>({...broker}),
    verifyOwnerRevocation:async()=>false});
  return {gate,request,counts};
}
test('AI-04 canonical signed JSON allows disposable callback',async()=>{
  const f=fixture();let effects=0;
  assert.equal(await f.gate.execute(f.request,async()=>++effects),1);
  assert.equal(effects,1);
  assert.deepEqual(f.counts,{begin:1,commit:1,release:1});
});
for(const stage of ['reserve','commit'] as const){
  for(const variant of ['whitespace','duplicate-key','escaped-value','invalid-utf8'] as const){
    test('AI-04 signed noncanonical '+variant+' at '+stage+' denies effect',async()=>{
      const f=fixture({stage,variant});let effects=0;
      await assert.rejects(f.gate.execute(f.request,async()=>++effects),
        {code:'DISPATCH_SIGNATURE_UNTRUSTED'});
      assert.equal(effects,0);
      assert.equal(f.counts.begin,1);
      assert.equal(f.counts.commit,stage==='reserve'?0:1);
    });
  }
}
