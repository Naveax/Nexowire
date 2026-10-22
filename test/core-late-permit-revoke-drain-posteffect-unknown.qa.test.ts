/**
 * Worker #25 follow-up to #731/#712 (SOURCE-ONLY).
 *
 * #731 already reproduces an unsafe #712 inter-Hub timing window using
 * the REAL BrokerExternalDispatchFence implementation on its DIFFERENT
 * unmerged branch. This QA does not duplicate #731 or pretend that #712
 * safely blocks the window. Instead it tests the missing downstream
 * acceptance: a late valid permit may have led to an irreversible effect;
 * missing revoke/ACK/readback MUST remain UNKNOWN across Hub failover.
 *
 * Real Ed25519 signing/verification, but the two Hubs, grant, CAS, OS
 * side effect and postcondition are IN-MEMORY fixtures. No real Broker,
 * UAC, operating-system mutation, Agent or VM is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign, verify} from 'node:crypto';
import {CORE_EXECUTOR_DISPATCH_ENABLED} from '../src/security/core-broker-executor-contract.js';

const signer=generateKeyPairSync('ed25519');
const stranger=generateKeyPairSync('ed25519');
const T0=Date.parse('2026-10-22T00:00:00.000Z');
const ROOT_END=T0+900_000;
const REQUEST='fd126d10-d1ab-4fa9-baad-fd1925005025';
const SECOND='fd126d10-d1ab-4fa9-baad-fd1925005026';
const OLD_OWNER='owner-25';
const NEW_OWNER='owner-26';
type Mode='CORE'|'ROOT';
type Scope={
  requestId:string;deviceId:string;ownerId:string;
  ownerEpoch:number;grantGeneration:number;sessionEpoch:string;
  mode:Mode;
};
type ReceiptBody={
  domain:'qa25.late-permit.v1';scope:Scope;
  dispatchId:string;challengeNonce:string;
  issuedAt:number;expiresAt:number;
};
type Receipt=ReceiptBody&{signature:string};
type Mutation='RESERVED'|'MUTATION_UNKNOWN'|'CANCELLED_NO_EFFECT'|'EFFECT_VERIFIED';
function scope(mode:Mode='CORE',requestId=REQUEST):Scope{
  return {
    requestId,deviceId:'device-25',ownerId:OLD_OWNER,
    ownerEpoch:25,grantGeneration:7,sessionEpoch:'session-25',mode,
  };
}
function ownerRepaired(s:Scope,id=requestIdOf(s)):Scope{
  return {...s,requestId:id,ownerId:NEW_OWNER,
    ownerEpoch:26,grantGeneration:9,sessionEpoch:'session-26'};
}
function requestIdOf(s:Scope){return s.requestId;}
function issuePermit(s:Scope,at:number):Receipt{
  const value:ReceiptBody={
    domain:'qa25.late-permit.v1',scope:s,
    dispatchId:'dispatch:'+s.requestId,
    challengeNonce:'f'.repeat(64),
    issuedAt:at,expiresAt:at+5_000,
  };
  return {...value,signature:sign(null,Buffer.from(JSON.stringify(value)),
    signer.privateKey).toString('base64url')};
}
function validPermit(p:Receipt,s:Scope,now:number):boolean{
  if(p.domain!=='qa25.late-permit.v1'||p.issuedAt>now||
     p.expiresAt<=now||p.expiresAt-p.issuedAt>5_000||
     p.scope.requestId!==s.requestId||
     JSON.stringify(p.scope)!==JSON.stringify(s)||
     p.dispatchId!=='dispatch:'+s.requestId||
     !/^[a-f0-9]{64}$/.test(p.challengeNonce)||
     !/^[A-Za-z0-9_-]{86}$/.test(p.signature))return false;
  const sig=Buffer.from(p.signature,'base64url');
  if(sig.length!==64||sig.toString('base64url')!==p.signature)return false;
  const {signature:_unused,...payload}=p;
  return verify(null,Buffer.from(JSON.stringify(payload)),signer.publicKey,sig);
}
type Entry={scope:Scope;mutation:Mutation;launched:boolean;launchAt:number};
class SharedSyntheticHistory {
  readonly reservations=new Map<string,Entry>();
  readonly effects:string[]=[];
  readonly ackMessages:string[]=[];
  revoking=false;revoked=false;readbackAvailable=true;
  ownerId=OLD_OWNER;ownerEpoch=25;grantGeneration=7;sessionEpoch='session-25';

  private isCurrent(s:Scope):boolean{
    return s.ownerId===this.ownerId&&s.ownerEpoch===this.ownerEpoch&&
      s.grantGeneration===this.grantGeneration&&
      s.sessionEpoch===this.sessionEpoch&&!this.revoking&&!this.revoked;
  }
  reserve(s:Scope,now:number):boolean{
    if(!this.isCurrent(s)||this.reservations.has(s.requestId)||
       s.mode==='ROOT'&&now>=ROOT_END)return false;
    this.reservations.set(s.requestId,{
      scope:s,mutation:'RESERVED',launched:false,launchAt:0,
    });
    return true;
  }
  startRemoteRevoke():void{
    // Revoke must fence *new* CAS reservations. Already allocated permits
    // are the contested #731 race; no native cancellation is proven here.
    this.revoking=true;
  }
  deliverLatePermit(p:Receipt,s:Scope,at:number):boolean{
    const e=this.reservations.get(s.requestId);
    return Boolean(e&&!e.launched&&
      JSON.stringify(e.scope)===JSON.stringify(s)&&validPermit(p,s,at));
  }
  /**
   * Emulate the proven UNSAFE #731 behavior: a previously admitted permit
   * delivered only after Hub B has started revoking can reach an effect.
   * This intentionally DOES NOT claim a native dispatch fence exists.
   */
  unsafeEffectAfterRevokeStarted(s:Scope,at:number,p:Receipt):boolean{
    const e=this.reservations.get(s.requestId);
    if(!this.revoking||this.revoked||!e||e.launched||
       !this.deliverLatePermit(p,s,at)||s.mode==='ROOT'&&at>=ROOT_END)
      return false;
    e.launched=true;e.launchAt=at;e.mutation='MUTATION_UNKNOWN';
    this.effects.push('synthetic-native-effect:'+s.requestId);
    return true;
  }
  /**
   * Required *future* protected/native barrier. This is not implemented by
   * the unmerged #712 source and must not be counted as a production PASS.
   */
  expectedNativeFence(s:Scope,at:number):boolean{
    return this.isCurrent(s)&&
      (s.mode!=='ROOT'||at<ROOT_END);
  }
  finishDrainWithLostAck():void{
    this.revoking=false;this.revoked=true;this.grantGeneration++;
    // A completed drain/ACK does NOT undo an effect already started.
  }
  failObserver():void{this.readbackAvailable=false}
  readback(s:Scope):Mutation|null{
    const e=this.reservations.get(s.requestId);
    if(!e||JSON.stringify(e.scope)!==JSON.stringify(s))return null;
    // Missing authoritative immutable readback can never prove EFFECT or
    // NO_EFFECT; even an external drain receipt is insufficient.
    return e.mutation;
  }
  noAutomaticReplay(s:Scope):boolean{
    return this.reservations.has(s.requestId);
  }
  repairOwner():void{
    this.revoked=false;this.ownerId=NEW_OWNER;
    this.ownerEpoch=26;this.grantGeneration=9;
    this.sessionEpoch='session-26';
  }
  brokerAck(requestId:string,ackId:string):Mutation|null{
    this.ackMessages.push(ackId);
    return this.reservations.get(requestId)?.mutation??null;
  }
}
function latch(){
  let release!:()=>void;
  const promise=new Promise<void>(done=>{release=done});
  return {promise,release:()=>release()};
}

test('#731 late VALID permit after Hub-B revoke starts: lost native ACK/readback stays UNKNOWN after drain, cannot replay',async()=>{
  assert.equal(CORE_EXECUTOR_DISPATCH_ENABLED,false);
  const cas=new SharedSyntheticHistory(),s=scope('CORE');
  const at=T0+20_000;
  const permit=issuePermit(s,at);
  assert.equal(cas.reserve(s,at),true);
  const alreadyReserved=latch(),permitArrives=latch();
  const launch=(async()=>{
    alreadyReserved.release();
    await permitArrives.promise;
    return cas.unsafeEffectAfterRevokeStarted(s,at+1,permit);
  })();
  await alreadyReserved.promise;
  cas.startRemoteRevoke(); // Different Hub B; Hub A knows only old grant.
  assert.equal(cas.reserve(scope('CORE',SECOND),at),false);
  assert.equal(cas.expectedNativeFence(s,at+1),false,
    'required future native revalidation must fence new effects');
  assert.equal(validPermit(permit,s,at+1),true,
    'cryptographically valid permit is NOT current authorization');
  permitArrives.release();
  assert.equal(await launch,true,
    'UNSAFE reproduction: effect after revoke began, as found by #731');
  assert.deepEqual(cas.effects,['synthetic-native-effect:'+REQUEST]);
  assert.equal(cas.readback(s),'MUTATION_UNKNOWN');

  // Hub-A crashes, Hub-B receives duplicated ACK and loses readback.
  cas.failObserver();
  for(const id of ['duplicate-ack','duplicate-ack','later-ack']){
    assert.equal(cas.brokerAck(REQUEST,id),'MUTATION_UNKNOWN');
  }
  cas.finishDrainWithLostAck();
  assert.equal(cas.readback(s),'MUTATION_UNKNOWN',
    'drained lease != irreversible-effect cancellation');
  assert.equal(cas.noAutomaticReplay(s),true);
  assert.equal(cas.reserve(s,at+2),false);
  cas.repairOwner();
  const foreign=ownerRepaired(s);
  assert.equal(cas.reserve(foreign,at+3),false,
    'globally used requestId never reopens on foreign owner re-pair');
  assert.equal(cas.deliverLatePermit(permit,foreign,at+3),false);
  assert.equal(cas.readback(foreign),null);
  assert.equal(cas.readback(s),'MUTATION_UNKNOWN');
  assert.equal(cas.effects.length,1);
});

test('ROOT signed permit issued at 899999ms, delivered at 900000ms: deny actual dispatch, no falsely proven cancellation',()=>{
  assert.equal(CORE_EXECUTOR_DISPATCH_ENABLED,false);
  const cas=new SharedSyntheticHistory(),s=scope('ROOT');
  const issued=ROOT_END-1,delivered=ROOT_END;
  assert.equal(cas.reserve(s,issued),true);
  const signed=issuePermit(s,issued);
  cas.startRemoteRevoke();
  assert.equal(validPermit(signed,s,delivered),true,
    'permit still cryptographically valid at ROOT expiration');
  assert.equal(cas.deliverLatePermit(signed,s,delivered),true);
  assert.equal(cas.expectedNativeFence(s,delivered),false,
    'ROOT deadline is checked at effect boundary, not issue time');
  assert.equal(cas.unsafeEffectAfterRevokeStarted(s,delivered,signed),false);
  assert.equal(cas.readback(s),'RESERVED',
    'without authenticated never-dispatched receipt cannot assert CANCELLED');
  cas.failObserver();cas.finishDrainWithLostAck();
  assert.equal(cas.readback(s),'RESERVED');
  assert.equal(cas.noAutomaticReplay(s),true);
  assert.equal(cas.effects.length,0);
});

test('revoke commits before fresh reserve, but signed historical permit cannot resurrect owner or cross-Hub requestId',()=>{
  const cas=new SharedSyntheticHistory(),s=scope('CORE'),at=T0+20_000;
  assert.equal(cas.reserve(s,at),true);
  const old=issuePermit(s,at);
  cas.startRemoteRevoke();
  cas.finishDrainWithLostAck();
  assert.equal(cas.reserve(scope('CORE',SECOND),at+1),false);
  assert.equal(cas.expectedNativeFence(s,at+1),false);
  assert.equal(cas.unsafeEffectAfterRevokeStarted(s,at+1,old),false);
  cas.repairOwner();
  assert.equal(cas.reserve(ownerRepaired(s),at+2),false);
  assert.equal(cas.deliverLatePermit(old,ownerRepaired(s),at+2),false);
  const fresh=ownerRepaired(s,SECOND);
  assert.equal(cas.reserve(fresh,at+3),true,
    'only distinct new request under genuinely re-paired owner may reserve');
  assert.equal(cas.effects.length,0);
});
