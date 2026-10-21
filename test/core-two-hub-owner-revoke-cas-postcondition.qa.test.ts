import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHash,generateKeyPairSync,sign,verify,
  type KeyObject,
} from 'node:crypto';
import {
  CORE_EXECUTOR_DISPATCH_ENABLED,
  evaluateCoreBrokerExecution,
  type CoreBrokerContext,
} from '../src/security/core-broker-executor-contract.js';

/**
 * Independent P0 #25 cross-owner acceptance, SOURCE ONLY.
 * Actual PR #712 CAS code and #719 Access reviewer are on DIFFERENT
 * unmerged parent stacks; this file is based on #716 and cannot import
 * them. Their contracts are compared to this adversarial SOURCE oracle.
 *
 * Fake high token, external CAS, signed witness, immutable object, two Hubs,
 * ACK, and irrevocable effects are IN-MEMORY FIXTURES. No shell, UAC, Agent,
 * installed Broker, remote DB, network or VM is touched.
 */
const cryptoWitness=generateKeyPairSync('ed25519');
const cryptoObserver=generateKeyPairSync('ed25519');
const untrusted=generateKeyPairSync('ed25519');
const time0=Date.parse('2026-10-21T12:45:00.000Z');
const rootEnd=time0+900_000;
const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64);
const ownerA='25a00000-0000-4000-8000-000000000025';
const ownerB='25b00000-0000-4000-8000-000000000026';
const device='25d00000-0000-4000-8000-000000000025';
const deviceEpoch='25e00000-0000-4000-8000-000000000025';
const sessionA='25a10000-0000-4000-8000-000000000025';
const sessionB='25b10000-0000-4000-8000-000000000026';
const requestId='fd126d10-d1ab-4fa9-baad-fd1925004025';
const secondId='fd126d10-d1ab-4fa9-baad-fd1925004026';
type Mode='CORE'|'ROOT';
type OwnerScope={
  requestId:string;ownerId:string;deviceId:string;deviceEpoch:string;
  sessionEpoch:string;ownerEpoch:number;grantGeneration:number;
  credentialBinding:string;mode:Mode;fingerprint:string;
};
type State='RESERVED_NO_DISPATCH'|'CANCELLED_NO_EFFECT'|
  'MUTATION_UNKNOWN'|'EFFECT_VERIFIED';
type SignedPermit={
  kind:'qa25.dispatch-permit.v1';scopeHash:string;issuedAtMs:number;
  expiresAtMs:number;nonce:string;signature:string;
};
function permitBytes(p:Omit<SignedPermit,'signature'>):Buffer{
  return Buffer.from(JSON.stringify([
    'QA25-CAS-PERMIT',p.kind,p.scopeHash,p.issuedAtMs,
    p.expiresAtMs,p.nonce,
  ]));
}
function mintPermit(s:OwnerScope,now:number):SignedPermit{
  const v={
    kind:'qa25.dispatch-permit.v1' as const,scopeHash:hash(s),
    issuedAtMs:now,expiresAtMs:now+5_000,
    nonce:hash([s.requestId,s.ownerEpoch,s.grantGeneration,now]),
  };
  return {...v,signature:sign(null,permitBytes(v),
    cryptoWitness.privateKey).toString('base64url')};
}
function checkPermit(p:SignedPermit,s:OwnerScope,atMs:number):boolean{
  if(p.kind!=='qa25.dispatch-permit.v1'||p.scopeHash!==hash(s)||
     p.issuedAtMs>atMs||p.expiresAtMs<=atMs||
     p.expiresAtMs-p.issuedAtMs>5_000)return false;
  if(!/^[A-Za-z0-9_-]{86}$/.test(p.signature))return false;
  const bytes=Buffer.from(p.signature,'base64url');
  if(bytes.length!==64||bytes.toString('base64url')!==p.signature)return false;
  const {signature:_unused,...unsigned}=p;
  return verify(null,permitBytes(unsigned),cryptoWitness.publicKey,bytes);
}
type Entry={
  scope:OwnerScope;launched:boolean;state:State;
  launchId:string;launchAt:number;expectedDigest:string;
  permit:SignedPermit;
};
function hash(x:unknown){return createHash('sha256').update(JSON.stringify(x)).digest('hex')}
function scope(id=requestId,mode:Mode='CORE',ownerId=ownerA,
  ownerEpoch=25,generation=7,session=sessionA,binding=B):OwnerScope{
  return {
    requestId:id,ownerId,deviceId:device,deviceEpoch,
    sessionEpoch:session,ownerEpoch,grantGeneration:generation,
    credentialBinding:binding,mode,
    fingerprint:hash(['core.process.start','synthetic-no-spawn']),
  };
}
function sameScope(a:OwnerScope,b:OwnerScope){
  return hash(a)===hash(b);
}
function sourceCtx(s:OwnerScope,now:number):CoreBrokerContext{
  return {
    now:new Date(now),deviceId:s.deviceId,ownerAccountId:s.ownerId,
    credentialBinding:s.credentialBinding,authoritativeOwnerEpoch:s.ownerEpoch,
    ownerRevoked:false,
    enrollment:{
      deviceId:s.deviceId,ownerAccountId:s.ownerId,ownerEpoch:s.ownerEpoch,
      credentialBinding:s.credentialBinding,
      enrollmentId:'25c00000-0000-4000-8000-000000000025',
      mode:s.mode,activatedAt:new Date(time0).toISOString(),
      expiresAt:s.mode==='ROOT'?new Date(rootEnd).toISOString():null,
      ownerSignedGrantDigest:C,brokerInstalledImageSha256:A,
    },
    localBootstrap:{
      localPhysicalUacConsentVerified:true,
      signedEnrollmentStoredInProtectedBroker:true,
      trustedInstallerRollbackBindingVerified:true,
    },
    trustedRuntime:{
      evidenceProvenance:'independent-windows-native',
      brokerProcessHighIntegrity:true,administratorsTokenEnabled:true,
      brokerAuthenticatedAndVersionMatched:true,
      runningImageIdentityMatched:true,expectedBrokerImageSha256:A,
      imageAuthenticodePublisherPinned:true,
      signedReleaseAndRollbackManifestVerified:true,
      brokerExeAndParentAclProtected:true,importedModulesAclProtected:true,
      updaterPathsAclProtected:true,processHandleDuplicationBoundaryProtected:true,
    },
    ownerIntentSignatureVerified:true,enrollmentSignatureVerified:true,
    ownerEpochWitnessVerified:true,requestAlreadyReserved:()=>false,
    pendingMutationUnknown:false,approvedVmIds:[],
    stopProcessIdentityVerified:true,
  };
}
function sourceAdmission(s:OwnerScope,now:number){
  const req={
    type:'core-broker.execute' as const,version:1 as const,
    requestId:s.requestId,deviceId:s.deviceId,ownerAccountId:s.ownerId,
    ownerEpoch:s.ownerEpoch,credentialBinding:s.credentialBinding,
    mode:s.mode,action:'core.process.start' as const,
    issuedAt:new Date(rootEnd-30_000).toISOString(),
    expiresAt:new Date(s.mode==='ROOT'?rootEnd:rootEnd+30_000).toISOString(),
    shell:{executable:'synthetic-no-spawn',arguments:[]},
  };
  return evaluateCoreBrokerExecution(req,sourceCtx(s,now));
}
type SignedReadback={
  domain:'qa25.synthetic.independent-postcondition.v2';
  scope:OwnerScope;launchId:string;observedAtMs:number;
  immutableId:string;actualDigest:string;status:'EFFECT';
  signature:string;
};
function signedReadback(s:OwnerScope,atMs:number,
  signer:KeyObject=cryptoObserver.privateKey):SignedReadback{
  const v={
    domain:'qa25.synthetic.independent-postcondition.v2' as const,
    scope:s,launchId:'launch:'+s.requestId,
    observedAtMs:atMs,immutableId:'immutable:'+s.requestId,
    actualDigest:hash(['effect',s.requestId]),status:'EFFECT' as const,
  };
  return {...v,signature:sign(null,Buffer.from(JSON.stringify(v)),
    signer).toString('base64url')};
}
function trustedReadback(r:SignedReadback):boolean{
  if(!r||r.domain!=='qa25.synthetic.independent-postcondition.v2')return false;
  const {signature,...v}=r;
  if(typeof signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(signature))return false;
  const bytes=Buffer.from(signature,'base64url');
  if(bytes.length!==64||bytes.toString('base64url')!==signature)return false;
  return verify(null,Buffer.from(JSON.stringify(v)),cryptoObserver.publicKey,bytes);
}
/**
 * This is a *single external source of truth* only in the specification:
 * two synthetic Hubs use a SHARED in-memory object, not two local ledgers.
 * In production #712 must implement actual linearizable CAS separately.
 */
class ExternalMonotonicOracle{
  ownerId=ownerA;ownerEpoch=25;generation=7;session=sessionA;
  credentialBinding=B;revoked=false;available=true;
  readonly ledger=new Map<string,Entry>();
  readonly syntheticLaunches:string[]=[];
  readonly seenAck=new Set<string>();
  readonly syntheticEffectMarkers:string[]=[];
  private current(s:OwnerScope){
    return !this.revoked&&s.ownerId===this.ownerId&&
      s.ownerEpoch===this.ownerEpoch&&s.grantGeneration===this.generation&&
      s.sessionEpoch===this.session&&s.credentialBinding===this.credentialBinding&&
      s.deviceId===device&&s.deviceEpoch===deviceEpoch;
  }
  // Read-only Access-like decision, explicitly NOT actual #719 reviewer
  review(s:OwnerScope,now:number):'REVIEWED_ONLY_NO_DISPATCH'|'DENIED'{
    if(!this.available||!this.current(s)||now>=rootEnd&&s.mode==='ROOT')
      return 'DENIED';
    return sourceAdmission(s,now).reason==='ELEVATED_DISPATCH_NOT_INSTALLED'
      ?'REVIEWED_ONLY_NO_DISPATCH':'DENIED';
  }
  reserve(s:OwnerScope,now:number){
    if(!this.available||!this.current(s)||this.ledger.has(s.requestId)||
      this.review(s,now)!=='REVIEWED_ONLY_NO_DISPATCH')return false;
    this.ledger.set(s.requestId,{
      scope:s,launched:false,state:'RESERVED_NO_DISPATCH',
      launchId:'launch:'+s.requestId,launchAt:0,
      expectedDigest:hash(['effect',s.requestId]),
      permit:mintPermit(s,now),
    });
    return true;
  }
  dispatch(s:OwnerScope,now:number,signedPermitTime:number){
    const e=this.ledger.get(s.requestId);
    if(!this.available||!e||e.launched||e.state!=='RESERVED_NO_DISPATCH'||
      !sameScope(e.scope,s)||!this.current(s)||
      signedPermitTime!==e.permit.issuedAtMs||
      !checkPermit(e.permit,s,now)||
      s.mode==='ROOT'&&now>=rootEnd||
      this.review(s,now)!=='REVIEWED_ONLY_NO_DISPATCH')return false;
    e.launched=true;e.state='MUTATION_UNKNOWN';e.launchAt=now;
    this.syntheticLaunches.push(e.launchId);
    this.syntheticEffectMarkers.push(e.expectedDigest);
    return true;
  }
  revoke(){
    this.revoked=true;this.generation++;
    // Revocation blocks NEW dispatch, never proves already launched no effect.
  }
  rePair(){
    this.ownerId=ownerB;this.ownerEpoch++;
    this.generation++;this.session=sessionB;
    this.credentialBinding=C;this.revoked=false;
  }
  cancel(s:OwnerScope,confirmedNoSend:boolean){
    const e=this.ledger.get(s.requestId);
    if(!e||!sameScope(e.scope,s))return null;
    if(!e.launched&&confirmedNoSend&&e.state==='RESERVED_NO_DISPATCH')
      e.state='CANCELLED_NO_EFFECT';
    return e.state;
  }
  ack(s:OwnerScope,ackId:string){
    const e=this.ledger.get(s.requestId);
    if(!e||!sameScope(e.scope,s))return null;
    this.seenAck.add(ackId);
    return e.state; // never promote ACK into verified postcondition
  }
  readback(s:OwnerScope,receipt:SignedReadback|null):State|null{
    const e=this.ledger.get(s.requestId);
    if(!e||!sameScope(e.scope,s))return null;
    if(!this.available||!e.launched||e.state!=='MUTATION_UNKNOWN'||!receipt||
      !trustedReadback(receipt)||!sameScope(e.scope,receipt.scope)||
      receipt.launchId!==e.launchId||
      receipt.immutableId!=='immutable:'+s.requestId||
      receipt.actualDigest!==e.expectedDigest||
      receipt.observedAtMs<e.launchAt)return e.state;
    e.state='EFFECT_VERIFIED';return e.state;
  }
  state(s:OwnerScope):State|null{
    return this.ledger.get(s.requestId)?.state??null;
  }
  signedPermit(s:OwnerScope):SignedPermit|null{
    return this.ledger.get(s.requestId)?.permit??null;
  }
}
class Hub{
  readonly cachedEffective=true;
  constructor(readonly name:string,readonly cas:ExternalMonotonicOracle){}
  review(s:OwnerScope,now:number){return this.cas.review(s,now)}
  reserve(s:OwnerScope,now:number){return this.cas.reserve(s,now)}
  dispatch(s:OwnerScope,now:number,permitAt:number|undefined=undefined){
    return this.cas.dispatch(s,now,
      permitAt??this.cas.signedPermit(s)?.issuedAtMs??now);
  }
}
function fixture(){
  const cas=new ExternalMonotonicOracle();
  return {cas,hubA:new Hub('Hub-A',cas),hubB:new Hub('Hub-B',cas)};
}

test('two-Hub simultaneous identical requestId claims serialize through one global CAS',async()=>{
  const {cas,hubA,hubB}=fixture(),s=scope(),now=rootEnd-2;
  assert.equal(hubA.review(s,now),'REVIEWED_ONLY_NO_DISPATCH');
  assert.equal(hubB.review(s,now),'REVIEWED_ONLY_NO_DISPATCH');
  const claims=await Promise.all([
    Promise.resolve().then(()=>hubA.reserve(s,now)),
    Promise.resolve().then(()=>hubB.reserve(s,now)),
  ]);
  assert.deepEqual(claims.sort(),[false,true]);
  assert.equal(hubA.dispatch(s,now),true);
  assert.equal(hubB.dispatch(s,now),false);
  assert.equal(cas.syntheticLaunches.length,1);
  assert.equal(cas.state(s),'MUTATION_UNKNOWN');
});

test('Access-like EFFECTIVE prior projection loses race to CAS revoke before side effect',()=>{
  const {cas,hubA,hubB}=fixture(),s=scope(),now=rootEnd-2;
  assert.equal(hubB.review(s,now),'REVIEWED_ONLY_NO_DISPATCH');
  cas.revoke(); // independent monotonic high-water advanced
  assert.equal(hubA.reserve(s,now),false);
  assert.equal(hubB.dispatch(s,now),false);
  assert.equal(cas.syntheticLaunches.length,0);
});

test('revoke after reserve but before native-effect fence requires signed no-send proof',()=>{
  const {cas,hubA,hubB}=fixture(),s=scope(),now=rootEnd-2;
  assert.equal(hubA.reserve(s,now),true);
  cas.revoke();
  assert.equal(hubB.dispatch(s,now),false);
  assert.equal(cas.cancel(s,false),'RESERVED_NO_DISPATCH');
  assert.equal(cas.cancel(s,true),'CANCELLED_NO_EFFECT');
  assert.equal(cas.syntheticEffectMarkers.length,0);
  assert.equal(hubA.dispatch(s,now),false);
});

test('two-Hub effect committed, revokeAndDrain ACK lost and readback offline => UNKNOWN',()=>{
  const {cas,hubA,hubB}=fixture(),s=scope(),now=rootEnd-2;
  assert.equal(hubA.reserve(s,now),true);
  assert.equal(hubA.dispatch(s,now),true);
  cas.revoke();cas.available=false;
  // Stalled/retried revoke and cached UI must never roll back an OS effect.
  assert.equal(hubB.review(s,now),'DENIED');
  assert.equal(cas.cancel(s,true),'MUTATION_UNKNOWN');
  assert.equal(cas.ack(s,'ACK-LOST-ON-BROKER-CRASH'),'MUTATION_UNKNOWN');
  assert.equal(cas.ack(s,'ACK-LOST-ON-BROKER-CRASH'),'MUTATION_UNKNOWN');
  assert.equal(cas.readback(s,null),'MUTATION_UNKNOWN');
  assert.equal(hubB.reserve(s,now),false);
  assert.equal(hubA.dispatch(s,now),false);
  assert.deepEqual(cas.syntheticLaunches,['launch:'+requestId]);
});

test('a cryptographically valid old-Hub permit is not new-owner authority',()=>{
  const {cas,hubA}=fixture(),old=scope(),now=rootEnd-2;
  assert.equal(hubA.reserve(old,now),true);
  const signed=cas.signedPermit(old);
  assert.ok(signed);
  assert.equal(checkPermit(signed,old,now),true);
  const stranger=scope(requestId,'CORE',ownerB,26,9,sessionB,C);
  assert.equal(checkPermit(signed,stranger,now),false);
  assert.equal(checkPermit({...signed,nonce:'tampered'},old,now),false);
  assert.equal(checkPermit({...signed,signature:'invalid'},old,now),false);
  assert.equal(hubA.dispatch(old,now),true);
  assert.equal(cas.syntheticLaunches.length,1);
});

test('foreign owner re-pair cannot reuse old requestId, even with fresh signed grant',()=>{
  const {cas,hubA,hubB}=fixture(),old=scope(),now=rootEnd-2;
  assert.equal(hubA.reserve(old,now),true);
  assert.equal(hubA.dispatch(old,now),true);
  cas.revoke();cas.rePair();
  const foreign=scope(requestId,'CORE',ownerB,26,9,sessionB,C);
  assert.equal(hubB.review(foreign,now),'REVIEWED_ONLY_NO_DISPATCH');
  assert.equal(hubB.reserve(foreign,now),false); // requestId used under old owner
  assert.equal(hubB.dispatch(foreign,now),false);
  assert.equal(cas.readback(foreign,signedReadback(old,now+1)),null);
  assert.equal(cas.state(old),'MUTATION_UNKNOWN');
  const fresh=scope(secondId,'CORE',ownerB,26,9,sessionB,C);
  assert.equal(hubB.reserve(fresh,now),true);
  assert.equal(hubB.dispatch(fresh,now),true);
  assert.equal(cas.syntheticLaunches.length,2);
  assert.equal(cas.state(old),'MUTATION_UNKNOWN');
});

test('ROOT signed permit at T-1 cannot cross the 900000ms native dispatch boundary',()=>{
  const {cas,hubA}=fixture(),s=scope(requestId,'ROOT');
  assert.equal(hubA.reserve(s,rootEnd-1),true);
  assert.equal(hubA.dispatch(s,rootEnd,rootEnd-1),false);
  assert.equal(cas.state(s),'RESERVED_NO_DISPATCH');
  assert.equal(cas.cancel(s,false),'RESERVED_NO_DISPATCH');
  assert.equal(cas.cancel(s,true),'CANCELLED_NO_EFFECT');
  assert.deepEqual(cas.syntheticLaunches,[]);
});
test('ROOT T-1 dispatched effect remains UNKNOWN after exact T expiry, even on other Hub',()=>{
  const {cas,hubA,hubB}=fixture(),s=scope(requestId,'ROOT');
  assert.equal(hubA.reserve(s,rootEnd-1),true);
  assert.equal(hubA.dispatch(s,rootEnd-1),true);
  assert.equal(hubB.review(s,rootEnd),'DENIED');
  cas.available=false;
  assert.equal(cas.readback(s,null),'MUTATION_UNKNOWN');
  assert.equal(cas.cancel(s,true),'MUTATION_UNKNOWN');
  assert.equal(hubB.dispatch(s,rootEnd),false);
  assert.equal(cas.syntheticLaunches.length,1);
});

test('signed independent readback lost, forged, or wrong immutable digest never clears UNKNOWN',()=>{
  const {cas,hubA}=fixture(),s=scope(),now=rootEnd-2;
  assert.equal(hubA.reserve(s,now),true);
  assert.equal(hubA.dispatch(s,now),true);
  const good=signedReadback(s,now+2);
  assert.equal(cas.readback(s,null),'MUTATION_UNKNOWN');
  assert.equal(cas.readback(s,signedReadback(s,now+2,untrusted.privateKey)),'MUTATION_UNKNOWN');
  assert.equal(cas.readback(s,{...good,immutableId:'foreign-result'}),'MUTATION_UNKNOWN');
  assert.equal(cas.readback(s,{...good,actualDigest:A}),'MUTATION_UNKNOWN');
  assert.equal(cas.readback(s,{...good,observedAtMs:now-1}),'MUTATION_UNKNOWN');
  cas.available=false;
  assert.equal(cas.readback(s,good),'MUTATION_UNKNOWN');
  cas.available=true;
  assert.equal(cas.state(s),'MUTATION_UNKNOWN');
  // Synthetic positive acceptance only; not proof of an actual native effect.
  assert.equal(cas.readback(s,good),'EFFECT_VERIFIED');
  assert.equal(cas.cancel(s,true),'EFFECT_VERIFIED');
});

test('CORE prior enrollment avoids repeated UAC while real dispatcher remains disabled',()=>{
  const {cas,hubA}=fixture(),now=rootEnd-2;
  for(const s of [scope(),scope(secondId)]){
    const real=sourceAdmission(s,now);
    assert.equal(CORE_EXECUTOR_DISPATCH_ENABLED,false);
    assert.equal(real.reason,'ELEVATED_DISPATCH_NOT_INSTALLED');
    assert.equal(real.requiresPerCommandUac,false);
    assert.equal(real.privilegedExecutionOccurred,false);
    assert.equal(hubA.reserve(s,now),true);
    assert.equal(hubA.dispatch(s,now),true);
  }
  assert.equal(cas.syntheticLaunches.length,2);
});
