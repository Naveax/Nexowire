/** AI-04 constructor dependency snapshot tests. Synthetic Ed25519 and
 * authority objects are NOT real protected Windows Broker/CAS evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {BrokerExternalDispatchFence,
  type BrokerDispatchRequest,type ProtectedBrokerEvidence,
  type DispatchClaim,type ExternalBrokerDispatchAuthority,
} from '../src/agent/broker-external-dispatch-fence.js';

const keys=generateKeyPairSync('ed25519');
const publicKeyPem=keys.publicKey.export({type:'spki',format:'pem'}).toString();
function fixture(){
  const authorityId=randomUUID(),brokerId=randomUUID(),dispatchId=randomUUID();
  const request:BrokerDispatchRequest={
    requestId:randomUUID(),fingerprint:'e'.repeat(64),capability:'shell.exec',
    scope:{ownerId:randomUUID(),deviceId:randomUUID(),
      deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),
      ownerEpoch:4,expectedGeneration:7,requiredPrivilege:'CORE'},
  };
  const broker:ProtectedBrokerEvidence={
    verified:true,brokerId,ownerEpoch:4,grantGeneration:7,
    highIntegrityToken:true,signedProtectedImage:true,
    protectedParentAndImports:true,
  };
  const counters={trustedBegin:0,attackerBegin:0};
  const claim=(kind:'broker_dispatch_permit_v1'|'broker_dispatch_commit_v1',
    nonce:string):DispatchClaim=>{
    const s=request.scope,now=Date.now();
    const bytes=Buffer.from(JSON.stringify({kind,authorityId,brokerId,
      dispatchId,challengeNonce:nonce,requestId:request.requestId,
      fingerprint:request.fingerprint,capability:request.capability,
      ownerId:s.ownerId,deviceId:s.deviceId,deviceEpoch:s.deviceEpoch,
      sessionEpoch:s.sessionEpoch,ownerEpoch:s.ownerEpoch,
      generation:s.expectedGeneration,privilege:s.requiredPrivilege,
      issuedAtMs:now,expiresAtMs:now+2000}),'utf8');
    return {payload:bytes.toString('base64url'),
      signature:sign(null,bytes,keys.privateKey).toString('base64url')};
  };
  const authority:ExternalBrokerDispatchAuthority={
    async beginIfCurrent(){counters.trustedBegin++;throw Error('OFFLINE_AUTHORITY')},
    async commitIfCurrent(){throw Error('UNEXPECTED_TRUSTED_COMMIT')},
    async release(){},
    async revokeAndDrain(){throw Error('NO_REVOKE')},
  };
  const swapped:ExternalBrokerDispatchAuthority={
    async beginIfCurrent(_req,_broker,nonce){
      counters.attackerBegin++;return claim('broker_dispatch_permit_v1',nonce);
    },
    async commitIfCurrent(_req,_broker,_id,nonce){
      return claim('broker_dispatch_commit_v1',nonce);
    },
    async release(){},
    async revokeAndDrain(){throw Error('NO_REVOKE')},
  };
  let trustedIdentityCalls=0;
  const config={
    authority,authorityId,publicKeyPem,
    verifyIdentity:async(_req:BrokerDispatchRequest)=>{
      trustedIdentityCalls++;return true;
    },
    verifyEffectiveBroker:async()=>({...broker}),
    verifyOwnerRevocation:async()=>false,
  };
  return {request,config,swapped,counters,
    identityCalls:()=>trustedIdentityCalls};
}

test('AI-04 pin remote CAS authority across caller config retargeting',async()=>{
  const f=fixture(),gate=new BrokerExternalDispatchFence(f.config);
  f.config.authority=f.swapped;
  let effects=0;
  await assert.rejects(gate.execute(f.request,async()=>++effects),
    {code:'DISPATCH_EXTERNAL_CAS_UNKNOWN'});
  assert.equal(effects,0);
  assert.equal(f.counters.trustedBegin,1);
  assert.equal(f.counters.attackerBegin,0);
});

test('AI-04 pin identity verification callback against false-to-true substitution',async()=>{
  const f=fixture();
  let originalChecks=0;
  f.config.verifyIdentity=async()=>{originalChecks++;return false};
  const gate=new BrokerExternalDispatchFence(f.config);
  f.config.verifyIdentity=async()=>true;
  f.config.authority=f.swapped;
  let effects=0;
  await assert.rejects(gate.execute(f.request,async()=>++effects),
    {code:'DISPATCH_IDENTITY_UNVERIFIED'});
  assert.equal(originalChecks,1);
  assert.equal(effects,0);
  assert.equal(f.counters.attackerBegin,0);
  assert.equal(f.counters.trustedBegin,0);
});

test('AI-04 refuse caller config accessor before executing getter',()=>{
  const f=fixture();let getterReads=0;
  Object.defineProperty(f.config,'verifyIdentity',{enumerable:true,
    get(){getterReads++;return async()=>true}});
  assert.throws(()=>new BrokerExternalDispatchFence(f.config),
    {code:'DISPATCH_CONFIG_INVALID'});
  assert.equal(getterReads,0);
});

test('AI-04 refuse constructor config Proxy trap without invoking authority',()=>{
  const f=fixture(),hostile=new Proxy(f.config,{
    getOwnPropertyDescriptor(){throw Error('UNTRUSTED_CONFIG_TRAP')},
  });
  assert.throws(()=>new BrokerExternalDispatchFence(hostile),
    {code:'DISPATCH_CONFIG_INVALID'});
  assert.equal(f.counters.trustedBegin,0);
});
