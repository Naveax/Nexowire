import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHash, generateKeyPairSync, sign, verify,
  type KeyObject,
} from 'node:crypto';
import {
  CORE_EXECUTOR_DISPATCH_ENABLED,
  evaluateCoreBrokerExecution,
  type CoreBrokerContext,
} from '../src/security/core-broker-executor-contract.js';

/**
 * P0 #25 signed evidence negative tests. ALL WITNESSES ARE SYNTHETIC.
 * Two independent Ed25519 keys in this process model the required provenance
 * split. Neither test-generated key is a real external authority.
 * No spawned process, real OS effect, UAC, Agent, Broker or VM.
 */
const witnessKey = generateKeyPairSync('ed25519');
const observerKey = generateKeyPairSync('ed25519');
const strangerKey = generateKeyPairSync('ed25519');
const shaA='a'.repeat(64),shaB='b'.repeat(64),shaC='c'.repeat(64),shaD='d'.repeat(64);
const baseId='fd126d10-d1ab-4fa9-baad-fd1925002025';
const nextId='fd126d10-d1ab-4fa9-baad-fd1925002026';
const thirdId='fd126d10-d1ab-4fa9-baad-fd1925002027';
const expiry=Date.parse('2026-10-21T13:00:00.000Z');
type Mode='CORE'|'ROOT';
type Event='RESERVED'|'DISPATCH_COMMITTED'|'NO_DISPATCH';
type State='RESERVED'|'CANCELLED_NO_EFFECT'|'MUTATION_UNKNOWN'|'EFFECT_VERIFIED';
type Effect='EFFECT'|'NO_EFFECT';

interface Scope {
  requestId:string;deviceId:string;ownerAccountId:string;
  ownerEpoch:number;grantGeneration:number;sessionEpoch:string;
  credentialBinding:string;mode:Mode;actionDigest:string;
}
type Request=ReturnType<typeof request>;
function request(id=baseId,mode:Mode='CORE',ownerId='owner-25',
  ownerEpoch=25,binding=shaB){
  return {
    type:'core-broker.execute' as const,version:1 as const,requestId:id,
    deviceId:'device-25',ownerAccountId:ownerId,ownerEpoch,
    credentialBinding:binding,mode,action:'core.process.start' as const,
    issuedAt:'2026-10-21T12:59:30.000Z',
    expiresAt:'2026-10-21T13:00:00.000Z',
    shell:{executable:'synthetic-not-an-executable',arguments:[] as string[]},
  };
}
function scope(r:Request,generation=7,session='session-epoch-25'):Scope{
  return {
    requestId:r.requestId,deviceId:r.deviceId,
    ownerAccountId:r.ownerAccountId,ownerEpoch:r.ownerEpoch,
    grantGeneration:generation,sessionEpoch:session,
    credentialBinding:r.credentialBinding,mode:r.mode,
    actionDigest:createHash('sha256').update(JSON.stringify([
      r.action,r.shell.executable,r.shell.arguments])).digest('hex'),
  };
}
function context(mode:Mode='CORE'):CoreBrokerContext{
  return {
    now:new Date(expiry-2),
    deviceId:'device-25',ownerAccountId:'owner-25',
    credentialBinding:shaB,authoritativeOwnerEpoch:25,ownerRevoked:false,
    enrollment:{
      deviceId:'device-25',ownerAccountId:'owner-25',
      credentialBinding:shaB,ownerEpoch:25,
      enrollmentId:'c2500000-0000-4000-8000-000000002025',
      activatedAt:'2026-10-21T12:45:00.000Z',
      expiresAt:mode==='ROOT'?'2026-10-21T13:00:00.000Z':null,
      mode,ownerSignedGrantDigest:shaC,brokerInstalledImageSha256:shaA,
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
      runningImageIdentityMatched:true,expectedBrokerImageSha256:shaA,
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
function gate(r:Request,c:CoreBrokerContext){
  return evaluateCoreBrokerExecution(r,c);
}
function sourceCandidate(r:Request,c:CoreBrokerContext):void{
  const result=gate(r,c);
  assert.equal(CORE_EXECUTOR_DISPATCH_ENABLED,false);
  assert.equal(result.reason,'ELEVATED_DISPATCH_NOT_INSTALLED');
  assert.equal(result.requiresPerCommandUac,false);
  assert.equal(result.oneTimeBootstrapAlreadyVerified,true);
  assert.equal(result.privilegedExecutionOccurred,false);
}
function scopeTuple(s:Scope):unknown[]{
  return [
    s.requestId,s.deviceId,s.ownerAccountId,s.ownerEpoch,
    s.grantGeneration,s.sessionEpoch,s.credentialBinding,
    s.mode,s.actionDigest,
  ];
}
function sameScope(a:Scope,b:Scope):boolean{
  return JSON.stringify(scopeTuple(a))===JSON.stringify(scopeTuple(b));
}
function exactScopeFields(s:Scope):boolean{
  if(!s||typeof s!=='object')return false;
  const required=['requestId','deviceId','ownerAccountId','ownerEpoch',
    'grantGeneration','sessionEpoch','credentialBinding','mode','actionDigest'];
  return Object.keys(s).sort().join(',')===required.sort().join(',');
}
interface Witness {
  protocol:'nexowire.test-only.witness.v1';
  issuer:'independent-witness-fixture';
  event:Event;seq:number;atMs:number;launchId:string;scope:Scope;
  signature:string;
}
interface Observation {
  protocol:'nexowire.test-only.postcondition.v1';
  issuer:'independent-observer-fixture';
  effect:Effect;observedAtMs:number;launchId:string;
  outputDigest:string;scope:Scope;signature:string;
}
function witnessBytes(w:Omit<Witness,'signature'>):Buffer{
  return Buffer.from(JSON.stringify([
    'WITNESS-NO-CROSS-PROTOCOL-v1',w.protocol,w.issuer,w.event,
    w.seq,w.atMs,w.launchId,...scopeTuple(w.scope),
  ]),'utf8');
}
function observerBytes(o:Omit<Observation,'signature'>):Buffer{
  return Buffer.from(JSON.stringify([
    'POSTCONDITION-NO-CROSS-PROTOCOL-v1',o.protocol,o.issuer,o.effect,
    o.observedAtMs,o.launchId,o.outputDigest,...scopeTuple(o.scope),
  ]),'utf8');
}
function makeWitness(event:Event,r:Request,seq:number,atMs:number,
  s=scope(r),privateKey:KeyObject=witnessKey.privateKey):Witness{
  const unsigned={
    protocol:'nexowire.test-only.witness.v1' as const,
    issuer:'independent-witness-fixture' as const,
    event,seq,atMs,launchId:'synthetic-launch:'+r.requestId,scope:s,
  };
  return {...unsigned,signature:sign(null,witnessBytes(unsigned),privateKey).toString('base64url')};
}
function makeObservation(r:Request,atMs:number,effect:Effect='EFFECT',
  s=scope(r),privateKey:KeyObject=observerKey.privateKey):Observation{
  const unsigned={
    protocol:'nexowire.test-only.postcondition.v1' as const,
    issuer:'independent-observer-fixture' as const,effect,
    observedAtMs:atMs,launchId:'synthetic-launch:'+r.requestId,
    outputDigest:shaD,scope:s,
  };
  return {...unsigned,signature:sign(null,observerBytes(unsigned),privateKey).toString('base64url')};
}
function canonicalSignature(sig:string):Buffer|null{
  if(!/^[A-Za-z0-9_-]{86}$/.test(sig))return null;
  const bytes=Buffer.from(sig,'base64url');
  return bytes.length===64&&bytes.toString('base64url')===sig?bytes:null;
}
function checkWitness(w:Witness):boolean{
  const required=['protocol','issuer','event','seq','atMs','launchId','scope','signature'];
  if(Object.keys(w).sort().join(',')!==required.sort().join(',')||
     !exactScopeFields(w.scope))return false;
  if(w.protocol!=='nexowire.test-only.witness.v1'||
     w.issuer!=='independent-witness-fixture'||
     !Number.isSafeInteger(w.seq)||w.seq<1||
     !Number.isSafeInteger(w.atMs)||w.atMs<1)return false;
  const sig=canonicalSignature(w.signature);
  if(!sig)return false;
  const {signature:_signature,...unsigned}=w;
  return verify(null,witnessBytes(unsigned),witnessKey.publicKey,sig);
}
function checkObservation(o:Observation):boolean{
  const required=['protocol','issuer','effect','observedAtMs','launchId','outputDigest','scope','signature'];
  if(Object.keys(o).sort().join(',')!==required.sort().join(',')||
     !exactScopeFields(o.scope))return false;
  if(o.protocol!=='nexowire.test-only.postcondition.v1'||
     o.issuer!=='independent-observer-fixture'||
     !Number.isSafeInteger(o.observedAtMs)||o.observedAtMs<1||
     !/^[a-f0-9]{64}$/.test(o.outputDigest))return false;
  const sig=canonicalSignature(o.signature);
  if(!sig)return false;
  const {signature:_signature,...unsigned}=o;
  return verify(null,observerBytes(unsigned),observerKey.publicKey,sig);
}
interface Entry {
  scope:Scope;launchId:string;lastAtMs:number;
  status:State;dispatchCommitted:boolean;
}
/**
 * Deliberately limited in-memory state machine defining expectations.
 * This is NOT a production journal, CAS, trusted physical observer or
 * atomic fence. Merely signing a made-up observation is no proof of OS effect.
 */
class TestOnlyEvidenceOracle {
  constructor(private trustedGeneration=7,
    private trustedSessionEpoch='session-epoch-25'){}
  // Synthetic trusted owner re-pair event: NOT an external authority.
  rePair(generation:number,sessionEpoch:string):void{
    this.trustedGeneration=generation;
    this.trustedSessionEpoch=sessionEpoch;
  }
  private readonly entries=new Map<string,Entry>();
  private lastSeq=0;
  private lastWitnessMs=0;
  readonly syntheticLaunchIds:string[]=[];
  witness(w:Witness,r:Request,c:CoreBrokerContext):boolean{
    if(!checkWitness(w)||!sameScope(w.scope,scope(r,
       this.trustedGeneration,this.trustedSessionEpoch)))return false;
    if(w.scope.requestId!==r.requestId||
       w.launchId!=='synthetic-launch:'+r.requestId||
       w.seq<=this.lastSeq||w.atMs<this.lastWitnessMs)return false;
    const existing=this.entries.get(r.requestId);
    if(w.event==='RESERVED'){
      if(existing||gate(r,c).reason!=='ELEVATED_DISPATCH_NOT_INSTALLED')return false;
      if(w.atMs!==c.now.getTime())return false;
      this.entries.set(r.requestId,{
        scope:w.scope,launchId:w.launchId,lastAtMs:w.atMs,
        status:'RESERVED',dispatchCommitted:false,
      });
    }else{
      if(!existing||!sameScope(existing.scope,w.scope)||
         w.atMs<existing.lastAtMs)return false;
      if(w.event==='NO_DISPATCH'){
        // Only the original signed never-dispatched source can say this.
        if(existing.dispatchCommitted||existing.status!=='RESERVED')return false;
        existing.status='CANCELLED_NO_EFFECT';
      }else if(w.event==='DISPATCH_COMMITTED'){
        if(existing.status!=='RESERVED'||existing.dispatchCommitted||
           gate(r,c).reason!=='ELEVATED_DISPATCH_NOT_INSTALLED'||
           w.atMs!==c.now.getTime())return false;
        const rootUntil=c.enrollment?.mode==='ROOT'
          ?Date.parse(c.enrollment.expiresAt??''):Infinity;
        if(w.atMs>=rootUntil)return false;
        existing.status='MUTATION_UNKNOWN';
        existing.dispatchCommitted=true;
        this.syntheticLaunchIds.push(w.launchId);
      }else return false;
      existing.lastAtMs=w.atMs;
    }
    this.lastSeq=w.seq;this.lastWitnessMs=w.atMs;
    return true;
  }
  observe(o:Observation):boolean{
    if(!checkObservation(o))return false;
    const e=this.entries.get(o.scope.requestId);
    if(!e||!sameScope(e.scope,o.scope)||e.launchId!==o.launchId||
       !e.dispatchCommitted||e.status!=='MUTATION_UNKNOWN'||
       o.observedAtMs<e.lastAtMs||
       o.effect!=='EFFECT')return false;
    // A signed effect receipt is a synthetic oracle verdict ONLY.
    e.status='EFFECT_VERIFIED';return true;
  }
  cancel(id:string):State|null{
    const e=this.entries.get(id);
    if(!e)return null;
    // Never infer a no-effect result from a cancellation request itself.
    return e.status;
  }
  lostAck(id:string):State|null{return this.cancel(id);}
  state(id:string):State|null{return this.entries.get(id)?.status??null;}
}
function setup(mode:Mode='CORE',r=request(baseId,mode)){
  const c=context(mode),oracle=new TestOnlyEvidenceOracle();
  sourceCandidate(r,c);
  assert.equal(oracle.witness(makeWitness('RESERVED',r,1,expiry-2),r,c),true);
  return {c,oracle,r};
}
function simulatedLaunch(oracle:TestOnlyEvidenceOracle,r:Request,c:CoreBrokerContext,
  sequence=2,atMs=expiry-1){
  c.now=new Date(atMs);
  assert.equal(oracle.witness(makeWitness('DISPATCH_COMMITTED',r,sequence,atMs),r,c),true);
}

test('signed no-dispatch witness AFTER revoke is needed for prelaunch cancellation',()=>{
  const {r,c,oracle}=setup();
  c.ownerRevoked=true;c.now=new Date(expiry-1);
  assert.equal(gate(r,c).reason,'GRANT_REVOKED');
  assert.equal(oracle.cancel(r.requestId),'RESERVED');
  assert.equal(oracle.witness(makeWitness('NO_DISPATCH',r,2,expiry-1),r,c),true);
  assert.equal(oracle.state(r.requestId),'CANCELLED_NO_EFFECT');
  assert.deepEqual(oracle.syntheticLaunchIds,[]);
  assert.equal(oracle.witness(makeWitness('DISPATCH_COMMITTED',r,3,expiry-1),r,c),false);
});

test('revocation after signed launch, before signed postcondition remains UNKNOWN',()=>{
  const {r,c,oracle}=setup();
  simulatedLaunch(oracle,r,c);
  c.ownerRevoked=true;c.pendingMutationUnknown=true;
  assert.equal(gate(r,c).reason,'GRANT_REVOKED');
  assert.equal(oracle.cancel(r.requestId),'MUTATION_UNKNOWN');
  assert.equal(oracle.lostAck(r.requestId),'MUTATION_UNKNOWN');
  assert.equal(oracle.witness(makeWitness('NO_DISPATCH',r,3,expiry-1),r,c),false);
  assert.equal(oracle.state(r.requestId),'MUTATION_UNKNOWN');
  assert.deepEqual(oracle.syntheticLaunchIds,['synthetic-launch:'+r.requestId]);
});

test('cryptographic negatives: wrong witness signer, altered scope, bad signature, duplicate seq',()=>{
  const r=request(),c=context(),oracle=new TestOnlyEvidenceOracle();
  const good=makeWitness('RESERVED',r,1,expiry-2);
  assert.equal(oracle.witness({...good,signature:'!'},r,c),false);
  assert.equal(oracle.witness(makeWitness('RESERVED',r,1,expiry-2,scope(r),
    strangerKey.privateKey),r,c),false);
  assert.equal(oracle.witness({...good,scope:{...good.scope,grantGeneration:8}},r,c),false);
  assert.equal(oracle.witness({...good,scope:{...good.scope,sessionEpoch:'repaired'}},r,c),false);
  assert.equal(oracle.witness({...good,event:'DISPATCH_COMMITTED'},r,c),false);
  assert.equal(oracle.witness({...good,scope:{...good.scope,clientApproved:true} as Scope},r,c),false);
  assert.equal(oracle.witness(good,r,c),true);
  assert.equal(oracle.witness(good,r,c),false);
  c.now=new Date(expiry-1);
  assert.equal(oracle.witness(makeWitness('DISPATCH_COMMITTED',r,1,expiry-1),r,c),false);
  assert.equal(oracle.witness(makeWitness('DISPATCH_COMMITTED',r,2,expiry-3),r,c),false);
  assert.equal(oracle.state(r.requestId),'RESERVED');
});

test('independent observer key must verify immutable postcondition and historical owner',()=>{
  const {r,c,oracle}=setup();simulatedLaunch(oracle,r,c);
  c.ownerRevoked=true;
  const genuine=makeObservation(r,expiry+2);
  assert.equal(oracle.observe({...genuine,signature:makeWitness(
    'NO_DISPATCH',r,4,expiry+2).signature}),false);
  assert.equal(oracle.observe(makeObservation(r,expiry+2,'EFFECT',scope(r),
    witnessKey.privateKey)),false);
  assert.equal(oracle.observe(makeObservation(r,expiry+2,'EFFECT',scope(r),
    strangerKey.privateKey)),false);
  assert.equal(oracle.observe({...genuine,ownerEpoch:26} as Observation),false);
  for(const scopePatch of [
    {ownerAccountId:'owner-26'},{ownerEpoch:26},
    {grantGeneration:8},{sessionEpoch:'session-epoch-26'},
    {credentialBinding:shaD},{requestId:nextId},
  ]){
    const forged=makeObservation(r,expiry+2,'EFFECT',{...scope(r),...scopePatch});
    assert.equal(oracle.observe(forged),false);
  }
  assert.equal(oracle.observe({...genuine,launchId:'other-launch'}),false);
  assert.equal(oracle.observe({...genuine,outputDigest:shaC}),false);
  assert.equal(oracle.observe({...genuine,scope:{...genuine.scope,attested:true} as Scope}),false);
  assert.equal(oracle.observe(makeObservation(r,expiry-3)),false);
  assert.equal(oracle.state(r.requestId),'MUTATION_UNKNOWN');
  assert.equal(oracle.observe(genuine),true);
  assert.equal(oracle.state(r.requestId),'EFFECT_VERIFIED');
  assert.equal(oracle.cancel(r.requestId),'EFFECT_VERIFIED');
});

test('even independently signed NO_EFFECT after dispatch must NOT undo launched side effect',()=>{
  const {r,c,oracle}=setup();simulatedLaunch(oracle,r,c);
  c.ownerRevoked=true;
  assert.equal(oracle.observe(makeObservation(r,expiry+1,'NO_EFFECT')),false);
  assert.equal(oracle.witness(makeWitness('NO_DISPATCH',r,3,expiry+1),r,c),false);
  assert.equal(oracle.state(r.requestId),'MUTATION_UNKNOWN');
});

test('duplicate lost ACK and re-pair cannot revive historical requestId or old receipt',()=>{
  const {r,c,oracle}=setup();simulatedLaunch(oracle,r,c);
  c.ownerAccountId='owner-26';c.authoritativeOwnerEpoch=26;
  c.credentialBinding=shaD;c.now=new Date(expiry-1);
  assert.equal(gate(r,c).reason,'WRONG_DEVICE_OR_OWNER_EPOCH');
  for(let i=0;i<4;i++){
    assert.equal(oracle.lostAck(r.requestId),'MUTATION_UNKNOWN');
    assert.equal(oracle.cancel(r.requestId),'MUTATION_UNKNOWN');
    assert.equal(oracle.witness(makeWitness('DISPATCH_COMMITTED',r,3+i,expiry-1),r,c),false);
  }
  const fresh=request(nextId,'CORE','owner-26',26,shaD);
  c.enrollment={...c.enrollment!,ownerAccountId:'owner-26',ownerEpoch:26,
    credentialBinding:shaD,enrollmentId:'c2600000-0000-4000-8000-000000002026'};
  const freshScope=scope(fresh,8,'session-epoch-26');
  oracle.rePair(8,'session-epoch-26');
  const reused=request(r.requestId,'CORE','owner-26',26,shaD);
  assert.equal(oracle.witness(makeWitness('RESERVED',reused,3,expiry-1,
    scope(reused,8,'session-epoch-26')),reused,c),false);
  assert.equal(oracle.witness(makeWitness('RESERVED',fresh,3,expiry-1,freshScope),fresh,c),true);
  assert.equal(oracle.witness(makeWitness('DISPATCH_COMMITTED',fresh,4,expiry-1,freshScope),fresh,c),true);
  assert.equal(oracle.observe(makeObservation(r,expiry+2,'EFFECT',
    {...scope(r),ownerAccountId:'owner-26'})),false);
  assert.equal(oracle.observe(makeObservation(r,expiry+2)),true);
  assert.equal(oracle.state(fresh.requestId),'MUTATION_UNKNOWN');
  assert.equal(oracle.syntheticLaunchIds.length,2);
});

test('ROOT 899999ms signed launch allowed; exact 900000ms prevents new dispatch',()=>{
  const r=request(baseId,'ROOT'),c=context('ROOT'),oracle=new TestOnlyEvidenceOracle();
  c.now=new Date(expiry-1);
  sourceCandidate(r,c);
  assert.equal(oracle.witness(makeWitness('RESERVED',r,1,expiry-1),r,c),true);
  assert.equal(oracle.witness(makeWitness('DISPATCH_COMMITTED',r,2,expiry-1),r,c),true);
  c.now=new Date(expiry);
  assert.equal(gate(r,c).automaticallyRetryable,false);
  assert.equal(oracle.cancel(r.requestId),'MUTATION_UNKNOWN');
  assert.equal(oracle.witness(makeWitness('NO_DISPATCH',r,3,expiry),r,c),false);
  const next=request(nextId,'ROOT');
  const expiryCrossing={...next,expiresAt:'2026-10-21T13:00:20.000Z'};
  assert.equal(gate(expiryCrossing,c).reason,'ROOT_15_MINUTES_EXCEEDED');
  assert.equal(oracle.witness(makeWitness('RESERVED',next,3,expiry),next,c),false);
  assert.equal(oracle.state(r.requestId),'MUTATION_UNKNOWN');
});

test('ROOT 900000ms before launch: no dispatch, signed no-send receipt required',()=>{
  const r=request(baseId,'ROOT'),c=context('ROOT'),oracle=new TestOnlyEvidenceOracle();
  c.now=new Date(expiry-1);
  assert.equal(oracle.witness(makeWitness('RESERVED',r,1,expiry-1),r,c),true);
  c.now=new Date(expiry);
  assert.equal(oracle.witness(makeWitness('DISPATCH_COMMITTED',r,2,expiry),r,c),false);
  assert.equal(oracle.state(r.requestId),'RESERVED');
  assert.equal(oracle.cancel(r.requestId),'RESERVED');
  assert.equal(oracle.witness(makeWitness('NO_DISPATCH',r,2,expiry),r,c),true);
  assert.equal(oracle.state(r.requestId),'CANCELLED_NO_EFFECT');
  assert.equal(oracle.syntheticLaunchIds.length,0);
});


test('ROOT expired before dispatch: signed timestamp backdating cannot override trusted now',()=>{
  const r=request(baseId,'ROOT'),c=context('ROOT'),oracle=new TestOnlyEvidenceOracle();
  c.now=new Date(expiry-1);
  assert.equal(oracle.witness(makeWitness('RESERVED',r,1,expiry-1),r,c),true);
  c.now=new Date(expiry);
  const backdated=makeWitness('DISPATCH_COMMITTED',r,2,expiry-1);
  assert.equal(checkWitness(backdated),true); // cryptographically valid but stale
  assert.equal(oracle.witness(backdated,r,c),false);
  assert.equal(oracle.witness(makeWitness('DISPATCH_COMMITTED',r,2,expiry),r,c),false);
  assert.deepEqual(oracle.syntheticLaunchIds,[]);
  assert.equal(oracle.state(r.requestId),'RESERVED');
  assert.equal(oracle.witness(makeWitness('NO_DISPATCH',r,2,expiry),r,c),true);
  assert.equal(oracle.state(r.requestId),'CANCELLED_NO_EFFECT');
});

test('preapproved CORE permits distinct commands without per-command UAC (source only)',()=>{
  const c=context('CORE'),oracle=new TestOnlyEvidenceOracle();
  for(const [i,id] of [baseId,nextId,thirdId].entries()){
    const r=request(id);
    c.now=new Date(expiry-2+i);
    if(i===2){
      // Third request expiry is exactly the boundary; independent enrollment
      // does not make an expired request valid.
      assert.equal(gate(r,c).reason,'GRANT_NOT_ACTIVE');
      break;
    }
    sourceCandidate(r,c);
    const atMs=c.now.getTime();
    const sc=scope(r);
    assert.equal(oracle.witness(makeWitness('RESERVED',r,2*i+1,atMs,sc),r,c),true);
    assert.equal(oracle.witness(makeWitness('DISPATCH_COMMITTED',r,2*i+2,atMs,sc),r,c),true);
    assert.equal(gate(r,c).requiresPerCommandUac,false);
  }
  assert.equal(oracle.syntheticLaunchIds.length,2);
  c.now=new Date(expiry-2);
  c.localBootstrap.signedEnrollmentStoredInProtectedBroker=false;
  const fresh=request(thirdId);
  assert.equal(gate(fresh,c).reason,'LOCAL_ONE_TIME_UAC_BOOTSTRAP_UNVERIFIED');
  assert.equal(gate(fresh,c).requiresPerCommandUac,false);
  assert.equal(oracle.witness(makeWitness('RESERVED',fresh,5,expiry-2),fresh,c),false);
});
