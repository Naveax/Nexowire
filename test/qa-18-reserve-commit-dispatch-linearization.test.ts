/**
 * #18 hostile SOURCE-ONLY contract for a PROPOSED external reserve -> 
 * commit-for-dispatch CAS barrier, NOT an implemented #01/native feature.
 *
 * The production #712 BrokerExternalDispatchFence executes the supplied
 * callback after checking a fresh Ed25519 nonce-bound permit. In THIS test
 * only, the callback invokes a synthetic final CAS that linearizes commits
 * against revoke-start. No real external CAS/Windows Broker/Agent/DB/VM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign,verify,type KeyObject}
 from 'node:crypto';
import {
 BrokerExternalDispatchFence,type BrokerDispatchRequest,
 type DispatchRevokeRequest,type DispatchClaim,
 type ExternalBrokerDispatchAuthority,type ProtectedBrokerEvidence,
} from '../src/agent/broker-external-dispatch-fence.js';
import {signedOperatorGrantVerifier}
 from '../src/agent/witness-signed-provenance.js';

function barrier(){
 let release!:()=>void;
 const promise=new Promise<void>(resolve=>{release=resolve});
 return {promise,release};
}
class QaContractError extends Error{
 constructor(readonly code:string){super(code)}
}
function signed(value:unknown,key:KeyObject):DispatchClaim{
 const bytes=Buffer.from(JSON.stringify(value));
 return {payload:bytes.toString('base64url'),
  signature:sign(null,bytes,key).toString('base64url')};
}
interface Lease{
 readonly request:BrokerDispatchRequest;
 readonly brokerId:string;
 readonly challengeNonce:string;
 readonly dispatchId:string;
 committed:boolean;
 sideEffectVerified:boolean;
}
/** Deterministic single-JS-process serialization, not durable external CAS. */
class SimulatedExternalCommitAuthority implements ExternalBrokerDispatchAuthority{
 readonly claims=new Map<string,Lease>();
 readonly requestTombstones=new Set<string>();
 readonly unknownClaims=new Set<string>();
 readonly revokeEntered=barrier();
 readonly drained=barrier();
 ownerEpoch=8;
 generation=12;
 revoking=false;
 revoked=false;
 effects=0;
 commitCount=0;
 readbackLost=false;
 constructor(readonly id:{
  authorityId:string;brokerId:string;ownerId:string;deviceId:string;
  deviceEpoch:string;sessionEpoch:string;
 },readonly privateSigner:KeyObject,readonly publicSigner:KeyObject){}
 private matching(r:BrokerDispatchRequest):boolean{
  const s=r.scope;
  return s.ownerId===this.id.ownerId&&s.deviceId===this.id.deviceId&&
   s.deviceEpoch===this.id.deviceEpoch&&s.sessionEpoch===this.id.sessionEpoch&&
   s.ownerEpoch===this.ownerEpoch&&s.expectedGeneration===this.generation&&
   s.requiredPrivilege==='CORE';
 }
 async beginIfCurrent(r:BrokerDispatchRequest,
   broker:ProtectedBrokerEvidence,challengeNonce:string):Promise<DispatchClaim>{
  if(this.revoking||this.revoked||!this.matching(r)||
    this.requestTombstones.has(r.requestId)||
    broker.brokerId!==this.id.brokerId||
    broker.ownerEpoch!==this.ownerEpoch||
    broker.grantGeneration!==this.generation)
   throw new QaContractError('TEST_RESERVE_DENIED');
  const dispatchId=randomUUID();
  this.requestTombstones.add(r.requestId);
  this.claims.set(dispatchId,{
   request:r,brokerId:broker.brokerId,challengeNonce,dispatchId,
   committed:false,sideEffectVerified:false,
  });
  const now=Date.now();
  return signed({kind:'broker_dispatch_permit_v1',
   authorityId:this.id.authorityId,brokerId:broker.brokerId,dispatchId,
   challengeNonce,requestId:r.requestId,fingerprint:r.fingerprint,
   capability:r.capability,ownerId:r.scope.ownerId,deviceId:r.scope.deviceId,
   deviceEpoch:r.scope.deviceEpoch,sessionEpoch:r.scope.sessionEpoch,
   ownerEpoch:r.scope.ownerEpoch,generation:r.scope.expectedGeneration,
   privilege:r.scope.requiredPrivilege,issuedAtMs:now,expiresAtMs:now+2500},
   this.privateSigner);
 }
 /**
  * PROPOSED API, NOT #712 production code. A linearizable synchronous
  * transition serialized with revoke-start in THIS in-memory model.
  * A reservation alone MUST NEVER authorize the native effect.
  */
 commitForDispatch(r:BrokerDispatchRequest):DispatchClaim{
  const lease=[...this.claims.values()].find(
   c=>c.request.requestId===r.requestId);
  if(!lease||this.revoking||this.revoked||!this.matching(r)||
     lease.committed||lease.request.fingerprint!==r.fingerprint||
     lease.request.capability!==r.capability||
     lease.request.scope.ownerEpoch!==r.scope.ownerEpoch||
     lease.request.scope.expectedGeneration!==r.scope.expectedGeneration)
   throw new QaContractError('TEST_FINAL_COMMIT_REVOKED_OR_STALE');
  lease.committed=true;
  this.commitCount++;
  const now=Date.now();
  return signed({kind:'broker_dispatch_commit_v1',
   authorityId:this.id.authorityId,dispatchId:lease.dispatchId,
   brokerId:lease.brokerId,challengeNonce:lease.challengeNonce,
   requestId:r.requestId,fingerprint:r.fingerprint,capability:r.capability,
   ownerId:r.scope.ownerId,deviceId:r.scope.deviceId,
   deviceEpoch:r.scope.deviceEpoch,sessionEpoch:r.scope.sessionEpoch,
   ownerEpoch:r.scope.ownerEpoch,generation:r.scope.expectedGeneration,
   privilege:r.scope.requiredPrivilege,
   issuedAtMs:now,expiresAtMs:now+2500},this.privateSigner);
 }
 verifyFinalCommit(r:BrokerDispatchRequest,receipt:DispatchClaim):string{
  const bytes=Buffer.from(receipt.payload,'base64url');
  const signature=Buffer.from(receipt.signature,'base64url');
  if(bytes.toString('base64url')!==receipt.payload||
     signature.toString('base64url')!==receipt.signature||
     signature.length!==64||
     !verify(null,bytes,this.publicSigner,signature))
   throw new QaContractError('TEST_FINAL_COMMIT_SIGNATURE_INVALID');
  const body=JSON.parse(bytes.toString('utf8')) as Record<string,unknown>;
  const lease=this.claims.get(String(body.dispatchId));
  if(body.kind!=='broker_dispatch_commit_v1'||!lease||
     !lease.committed||body.authorityId!==this.id.authorityId||
     body.brokerId!==this.id.brokerId||
     body.challengeNonce!==lease.challengeNonce||
     body.requestId!==r.requestId||body.fingerprint!==r.fingerprint||
     body.capability!==r.capability||body.ownerId!==r.scope.ownerId||
     body.deviceId!==r.scope.deviceId||
     body.deviceEpoch!==r.scope.deviceEpoch||
     body.sessionEpoch!==r.scope.sessionEpoch||
     body.ownerEpoch!==r.scope.ownerEpoch||
     body.generation!==r.scope.expectedGeneration||
     body.privilege!==r.scope.requiredPrivilege||
     typeof body.issuedAtMs!=='number'||
     typeof body.expiresAtMs!=='number'||
     body.issuedAtMs>Date.now()+1000||
     body.expiresAtMs<=Date.now()||
     body.expiresAtMs-body.issuedAtMs>5000)
   throw new QaContractError('TEST_FINAL_COMMIT_SCOPE_INVALID');
  return lease.dispatchId;
 }
 /** Simulated side-effect bookkeeping, NOT a real native OS mutation. */
 simulatedNativeEffect(commitId:string):void{
  const lease=this.claims.get(commitId);
  if(!lease?.committed||lease.sideEffectVerified)
   throw new QaContractError('TEST_EFFECT_WITHOUT_COMMIT');
  this.effects++;
 }
 /** A lost durable effect readback must NOT become COMPLETED_VERIFIED. */
 independentlyReadEffect(commitId:string):void{
  const lease=this.claims.get(commitId);
  if(!lease?.committed)throw new QaContractError('TEST_NO_EFFECT_COMMIT');
  if(this.readbackLost)
   throw new QaContractError('TEST_INDEPENDENT_READBACK_LOST');
  lease.sideEffectVerified=true;
 }
 async release(commitId:string):Promise<void>{
  const lease=this.claims.get(commitId);
  if(!lease)return;
  if(lease.committed&&!lease.sideEffectVerified)
   this.unknownClaims.add(commitId);
  this.claims.delete(commitId);
  if(this.claims.size===0)this.drained.release();
 }
 async revokeAndDrain(r:DispatchRevokeRequest):Promise<DispatchClaim>{
  if(this.revoking||this.revoked||
    r.ownerId!==this.id.ownerId||r.deviceId!==this.id.deviceId||
    r.deviceEpoch!==this.id.deviceEpoch||
    r.sessionEpoch!==this.id.sessionEpoch||
    r.expectedGeneration!==this.generation)
   throw new QaContractError('TEST_REVOKE_STALE');
  this.revoking=true; // linearization point: subsequent commits denied
  this.revokeEntered.release();
  if(this.claims.size>0)await this.drained.promise;
  if(this.unknownClaims.size>0)
   throw new QaContractError('TEST_DRAIN_UNVERIFIED_EFFECT_UNKNOWN');
  const previousGeneration=this.generation++;
  this.revoked=true;
  return signed({kind:'broker_dispatch_revocation_v1',
   authorityId:this.id.authorityId,deviceId:this.id.deviceId,
   ownerId:this.id.ownerId,deviceEpoch:this.id.deviceEpoch,
   sessionEpoch:this.id.sessionEpoch,previousGeneration,
   generation:this.generation,drained:true,revoked:true},this.privateSigner);
 }
}
function fixture(){
 const id={authorityId:randomUUID(),brokerId:randomUUID(),
  ownerId:randomUUID(),deviceId:randomUUID(),
  deviceEpoch:randomUUID(),sessionEpoch:randomUUID()};
 const key=generateKeyPairSync('ed25519'),
  ownerKey=generateKeyPairSync('ed25519');
 const cas=new SimulatedExternalCommitAuthority(
  id,key.privateKey,key.publicKey);
 const signer=signedOperatorGrantVerifier(
  ownerKey.publicKey.export({type:'spki',format:'pem'}).toString());
 const request:BrokerDispatchRequest={
  requestId:randomUUID(),fingerprint:'e'.repeat(64),
  capability:'hyperv.vm.start',
  scope:{ownerId:id.ownerId,deviceId:id.deviceId,
   deviceEpoch:id.deviceEpoch,sessionEpoch:id.sessionEpoch,
   ownerEpoch:cas.ownerEpoch,expectedGeneration:cas.generation,
   requiredPrivilege:'CORE'},
 };
 const gate=()=>new BrokerExternalDispatchFence({
  authority:cas,authorityId:id.authorityId,
  publicKeyPem:key.publicKey.export({type:'spki',format:'pem'}).toString(),
  verifyIdentity:async()=>true,
  // These flags DO NOT attest an installed protected Windows Broker.
  verifyEffectiveBroker:async()=>({
   verified:true,brokerId:id.brokerId,
   ownerEpoch:cas.ownerEpoch,grantGeneration:cas.generation,
   highIntegrityToken:true,signedProtectedImage:true,
   protectedParentAndImports:true,
  }),
  verifyOwnerRevocation:async r=>signer({
   kind:'revoke',authorityId:id.authorityId,
   deviceId:id.deviceId,ownerId:id.ownerId,
   epoch:id.deviceEpoch,sessionEpoch:id.sessionEpoch,
   generation:r.expectedGeneration,
  },r.signedOwnerApproval),
 });
 const revoke=():DispatchRevokeRequest=>{
  const issuedAt=Date.now();
  return {deviceId:id.deviceId,ownerId:id.ownerId,
   deviceEpoch:id.deviceEpoch,sessionEpoch:id.sessionEpoch,
   expectedGeneration:request.scope.expectedGeneration,
   signedOwnerApproval:JSON.stringify(signed({
    version:1,nonce:randomUUID(),
    issuedAt:issuedAt-1000,expiresAt:issuedAt+60000,
    intent:{kind:'revoke',authorityId:id.authorityId,
     deviceId:id.deviceId,ownerId:id.ownerId,
     epoch:id.deviceEpoch,sessionEpoch:id.sessionEpoch,
     generation:request.scope.expectedGeneration},
   },ownerKey.privateKey))};
 };
 return {id,cas,request,gate,revoke};
}

test('#18 atomic source model: Hub B revoke-start BEFORE Hub A commit denies native effect',async()=>{
 const f=fixture(),hubA=f.gate(),hubB=f.gate();
 const reservedBeforeCommit=barrier(),mayCommit=barrier();
 let finalChecks=0;
 const a=hubA.execute(f.request,async()=>{
  reservedBeforeCommit.release();
  await mayCommit.promise;
  finalChecks++;
  const receipt=f.cas.commitForDispatch(f.request);
  const id=f.cas.verifyFinalCommit(f.request,receipt);
  f.cas.simulatedNativeEffect(id);
 });
 await reservedBeforeCommit.promise;
 assert.equal(f.cas.claims.size,1,'permit reserved first');
 assert.equal(f.cas.commitCount,0);
 const b=hubB.revoke(f.revoke());
 await f.cas.revokeEntered.promise;
 assert.equal(f.cas.revoking,true);
 assert.equal(f.cas.revoked,false);
 mayCommit.release();
 await assert.rejects(a,{code:'TEST_FINAL_COMMIT_REVOKED_OR_STALE'});
 assert.equal(finalChecks,1);
 assert.equal(f.cas.commitCount,0);
 assert.equal(f.cas.effects,0,'NO simulated native side effect');
 assert.equal(f.cas.claims.size,0,'reserved lease released');
 const receipt=await b;
 assert.equal(receipt.drained,true);
 assert.equal(f.cas.generation,13);
 await assert.rejects(f.gate().execute(f.request,async()=>{
  throw Error('MUST_NEVER_EXECUTE');
 }),{code:'DISPATCH_EXTERNAL_CAS_UNKNOWN'});
 assert.equal(f.cas.effects,0);
});

test('#18 atomic source model: commit BEFORE revoke then side-effect readback lost -> UNKNOWN, no replay',async()=>{
 const f=fixture(),hubA=f.gate(),hubB=f.gate();
 const effectRecorded=barrier(),permitReadback=barrier();
 f.cas.readbackLost=true;
 let callbackEntered=0;
 const execution=hubA.execute(f.request,async()=>{
  callbackEntered++;
  const signedCommit=f.cas.commitForDispatch(f.request);
  const id=f.cas.verifyFinalCommit(f.request,signedCommit);
  f.cas.simulatedNativeEffect(id);
  effectRecorded.release();
  await permitReadback.promise;
  try{
   f.cas.independentlyReadEffect(id);
  }catch{
   // TEST-ONLY outcome translator, not #712's source error contract.
   throw new QaContractError('MUTATION_STATE_UNKNOWN');
  }
 });
 await effectRecorded.promise;
 assert.equal(f.cas.commitCount,1,'commit linearized first');
 assert.equal(f.cas.effects,1,'one synthetic native effect already occurred');
 const draining=hubB.revoke(f.revoke());
 await f.cas.revokeEntered.promise;
 assert.equal(f.cas.revoking,true);
 assert.equal(f.cas.revoked,false);
 permitReadback.release();
 await assert.rejects(execution,{code:'MUTATION_STATE_UNKNOWN'});
 assert.equal(f.cas.unknownClaims.size,1);
 await assert.rejects(draining,{code:'DISPATCH_REVOKE_OUTCOME_UNKNOWN'});
 assert.equal(f.cas.revoked,false,'no forged drained:true or verified outcome');
 assert.equal(f.cas.effects,1);
 assert.equal(callbackEntered,1);
 await assert.rejects(f.gate().execute(f.request,async()=>{
  f.cas.effects++;
 }),{code:'DISPATCH_EXTERNAL_CAS_UNKNOWN'});
 assert.equal(f.cas.effects,1,'UNKNOWN must never auto-replay the effect');
});
