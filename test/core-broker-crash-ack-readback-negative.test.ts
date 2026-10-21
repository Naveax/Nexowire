import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign, verify, type KeyObject} from 'node:crypto';
import {
  CORE_EXECUTOR_DISPATCH_ENABLED,
  evaluateCoreBrokerExecution,
  type CoreBrokerContext,
} from '../src/security/core-broker-executor-contract.js';

/**
 * #25 / SOURCE-ONLY acceptance. No native Broker, elevated process, UAC,
 * VM, real OS effect, or external authority is used. All Ed25519 signers,
 * crash/restart events, witness receipts and independent readbacks are local
 * fixtures. Tests enforce proposed semantics, NOT physical attestation.
 */
const brokerSigner=generateKeyPairSync('ed25519');
const witnessSigner=generateKeyPairSync('ed25519');
const observerSigner=generateKeyPairSync('ed25519');
const strangerSigner=generateKeyPairSync('ed25519');
const ROOT_END=Date.parse('2026-10-21T13:00:00.000Z');
const SHA_A='a'.repeat(64),SHA_B='b'.repeat(64),SHA_C='c'.repeat(64);
const IDS=[
  'fd126d10-d1ab-4fa9-baad-fd1925003025',
  'fd126d10-d1ab-4fa9-baad-fd1925003026',
  'fd126d10-d1ab-4fa9-baad-fd1925003027',
] as const;
type Mode='CORE'|'ROOT';
const request=(requestId:string=IDS[0],mode:Mode='CORE')=>({
  type:'core-broker.execute' as const,version:1 as const,requestId,
  deviceId:'device-25',ownerAccountId:'owner-25',ownerEpoch:25,
  credentialBinding:SHA_B,mode,action:'core.process.start' as const,
  issuedAt:'2026-10-21T12:59:30.000Z',
  expiresAt:mode==='ROOT'?'2026-10-21T13:00:00.000Z':'2026-10-21T13:00:20.000Z',
  shell:{executable:'synthetic-no-spawn',arguments:[] as string[]},
});
type Request=ReturnType<typeof request>;
function context(mode:Mode='CORE'):CoreBrokerContext{
  return {
    now:new Date(ROOT_END-1),
    deviceId:'device-25',ownerAccountId:'owner-25',credentialBinding:SHA_B,
    authoritativeOwnerEpoch:25,ownerRevoked:false,
    enrollment:{
      deviceId:'device-25',ownerAccountId:'owner-25',
      credentialBinding:SHA_B,ownerEpoch:25,
      enrollmentId:'c2500000-0000-4000-8000-000000003025',
      activatedAt:'2026-10-21T12:45:00.000Z',
      expiresAt:mode==='ROOT'?'2026-10-21T13:00:00.000Z':null,
      mode,ownerSignedGrantDigest:SHA_C,brokerInstalledImageSha256:SHA_A,
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
      runningImageIdentityMatched:true,expectedBrokerImageSha256:SHA_A,
      imageAuthenticodePublisherPinned:true,
      signedReleaseAndRollbackManifestVerified:true,
      brokerExeAndParentAclProtected:true,importedModulesAclProtected:true,
      updaterPathsAclProtected:true,processHandleDuplicationBoundaryProtected:true,
    },
    ownerIntentSignatureVerified:true,enrollmentSignatureVerified:true,
    ownerEpochWitnessVerified:true,requestAlreadyReserved:()=>false,
    pendingMutationUnknown:false,approvedVmIds:[],stopProcessIdentityVerified:true,
  };
}
function gate(r:Request,c:CoreBrokerContext){
  return evaluateCoreBrokerExecution(r,c);
}
function candidate(r:Request,c:CoreBrokerContext):boolean{
  assert.equal(CORE_EXECUTOR_DISPATCH_ENABLED,false);
  return gate(r,c).reason==='ELEVATED_DISPATCH_NOT_INSTALLED';
}
function digest(payload:unknown):string{
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
type Scope={
  requestId:string;deviceId:string;ownerAccountId:string;ownerEpoch:number;
  credentialBinding:string;mode:Mode;grantGeneration:number;
  sessionEpoch:string;actionDigest:string;
};
function scope(r:Request):Scope{
  return {
    requestId:r.requestId,deviceId:r.deviceId,ownerAccountId:r.ownerAccountId,
    ownerEpoch:r.ownerEpoch,credentialBinding:r.credentialBinding,mode:r.mode,
    grantGeneration:7,sessionEpoch:'session-25',
    actionDigest:digest([r.action,r.shell.executable,r.shell.arguments]),
  };
}
const scopeKeys=['requestId','deviceId','ownerAccountId','ownerEpoch',
  'credentialBinding','mode','grantGeneration','sessionEpoch','actionDigest'];
function shape(x:unknown,keys:string[]):boolean{
  return !!x&&typeof x==='object'&&!Array.isArray(x)&&
    Object.keys(x).sort().join('|')===keys.slice().sort().join('|');
}
type Signer='broker'|'witness'|'observer';
type Phase='RESERVE'|'DISPATCH'|'ACK'|'READBACK';
type Outcome='ACK_RECEIVED'|'EFFECT'|'UNAVAILABLE'|'NO_EFFECT';
type ReceiptBody={
  domain:'nexowire.qa25.synthetic.v1';issuer:Signer;
  phase:Phase;sequence:number;atMs:number;scope:Scope;
  launchId:string;outcome:Outcome;outputSha256:string;
};
type Receipt=ReceiptBody&{signature:string};
const receiptKeys=['domain','issuer','phase','sequence','atMs','scope',
  'launchId','outcome','outputSha256','signature'];
function unsigned(r:ReceiptBody):Buffer{
  return Buffer.from(JSON.stringify([
    'QA25-STRICT-DOMAIN',r.domain,r.issuer,r.phase,r.sequence,r.atMs,
    r.scope.requestId,r.scope.deviceId,r.scope.ownerAccountId,r.scope.ownerEpoch,
    r.scope.credentialBinding,r.scope.mode,r.scope.grantGeneration,
    r.scope.sessionEpoch,r.scope.actionDigest,r.launchId,r.outcome,r.outputSha256,
  ]),'utf8');
}
function key(issuer:Signer):{publicKey:KeyObject;privateKey:KeyObject}{
  return issuer==='broker'?brokerSigner:issuer==='witness'?witnessSigner:observerSigner;
}
function receipt(r:Request,issuer:Signer,phase:Phase,sequence:number,
  atMs:number,outcome:Outcome='ACK_RECEIVED',
  outputSha256=SHA_A,signer:KeyObject=key(issuer).privateKey):Receipt{
  const u:ReceiptBody={
    domain:'nexowire.qa25.synthetic.v1',issuer,phase,sequence,atMs,scope:scope(r),
    launchId:'synthetic-launch:'+r.requestId,outcome,outputSha256,
  };
  return {...u,signature:sign(null,unsigned(u),signer).toString('base64url')};
}
function authentic(r:Receipt,issuer:Signer):boolean{
  if(!shape(r,receiptKeys)||!shape(r.scope,scopeKeys)||
     r.domain!=='nexowire.qa25.synthetic.v1'||r.issuer!==issuer||
     !Number.isSafeInteger(r.sequence)||r.sequence<1||
     !Number.isSafeInteger(r.atMs)||r.atMs<1||
     !/^[a-f0-9]{64}$/.test(r.outputSha256)||
     !/^[A-Za-z0-9_-]{86}$/.test(r.signature))return false;
  const sig=Buffer.from(r.signature,'base64url');
  if(sig.length!==64||sig.toString('base64url')!==r.signature)return false;
  const {signature:_unused,...body}=r;
  return verify(null,unsigned(body),key(issuer).publicKey,sig);
}
type OutcomeState='RESERVED'|'CANCELLED_NO_EFFECT'|'MUTATION_UNKNOWN'|'EFFECT_VERIFIED';
type Item={
  immutableScope:Scope;launchId:string;
  dispatched:boolean;state:OutcomeState;
  ackDigest:string|null;sequence:number;integrityConflict:boolean;
};
/**
 * Specification oracle only. Independent authorities, durability, physical
 * postconditions and an atomic OS dispatch fence are NOT implemented.
 *
 * The same in-memory ledger is retained across synthetic Broker restarts to
 * model the required future external persistent authority.
 */
class TestOnlyDurableOracle{
  private readonly items=new Map<string,Item>();
  readonly syntheticDispatchEvents:string[]=[];
  online=true;
  reserve(r:Request,c:CoreBrokerContext):boolean{
    if(!this.online||this.items.has(r.requestId)||!candidate(r,c))return false;
    this.items.set(r.requestId,{
      immutableScope:scope(r),launchId:'synthetic-launch:'+r.requestId,
      dispatched:false,state:'RESERVED',ackDigest:null,sequence:0,
      integrityConflict:false,
    });
    return true;
  }
  launch(r:Request,c:CoreBrokerContext,proof:Receipt):boolean{
    const i=this.items.get(r.requestId);
    if(!this.online||!i||i.dispatched||i.state!=='RESERVED'||
       !authentic(proof,'witness')||proof.phase!=='DISPATCH'||
       proof.outcome!=='ACK_RECEIVED'||proof.atMs!==c.now.getTime()||
       proof.sequence<=i.sequence||
       digest(i.immutableScope)!==digest(proof.scope)||
       proof.launchId!==i.launchId||
       !candidate(r,c))return false;
    // Source gate already rejects ROOT expiry; explicit anchored deadline
    // check ensures signed timestamp cannot carry stale admission forward.
    if(r.mode==='ROOT'&&
       (c.enrollment?.expiresAt===null||
        proof.atMs>=Date.parse(c.enrollment?.expiresAt??'')))return false;
    i.dispatched=true;i.state='MUTATION_UNKNOWN';i.sequence=proof.sequence;
    this.syntheticDispatchEvents.push(i.launchId);
    return true;
  }
  cancel(r:Request,neverSent?:Receipt):OutcomeState|null{
    const i=this.items.get(r.requestId);
    if(!i)return null;
    if(!this.online)return i.dispatched?'MUTATION_UNKNOWN':i.state;
    if(i.dispatched)return i.state; // no cancellation of observed effect
    if(neverSent&&authentic(neverSent,'witness')&&
       neverSent.phase==='RESERVE'&&neverSent.outcome==='NO_EFFECT'&&
       neverSent.sequence>i.sequence&&
       neverSent.launchId===i.launchId&&
       digest(neverSent.scope)===digest(i.immutableScope)){
      i.state='CANCELLED_NO_EFFECT';i.sequence=neverSent.sequence;
    }
    return i.state;
  }
  ack(r:Request,proof:Receipt):OutcomeState|null{
    const i=this.items.get(r.requestId);
    if(!i)return null;
    if(!this.online||!i.dispatched)return i.state;
    if(!authentic(proof,'broker')||proof.phase!=='ACK'||
       proof.outcome!=='ACK_RECEIVED'||proof.launchId!==i.launchId||
       digest(proof.scope)!==digest(i.immutableScope))return i.state;
    const receiptDigest=digest(proof);
    if(i.ackDigest===null){
      if(proof.sequence<=i.sequence)return i.state;
      i.ackDigest=receiptDigest;i.sequence=proof.sequence;
    }else if(i.ackDigest!==receiptDigest){
      // Ambiguous conflicting duplicates cannot silently overwrite history.
      i.integrityConflict=true;
    }
    return i.state; // ACK != independent, immutable OS effect readback
  }
  observe(r:Request,proof:Receipt|null):OutcomeState|null{
    const i=this.items.get(r.requestId);
    if(!i)return null;
    if(!this.online||!i.dispatched||!proof||i.integrityConflict)return i.state;
    if(!authentic(proof,'observer')||proof.phase!=='READBACK'||
       proof.outcome!=='EFFECT'||proof.atMs<=0||
       proof.launchId!==i.launchId||
       proof.sequence<=i.sequence||
       digest(proof.scope)!==digest(i.immutableScope))return i.state;
    i.state='EFFECT_VERIFIED';
    return i.state;
  }
  state(r:Request):OutcomeState|null{return this.items.get(r.requestId)?.state??null;}
  hasConflict(r:Request):boolean{return this.items.get(r.requestId)?.integrityConflict??false;}
  // Simulated service restarts do NOT delete the external-authority fixture.
  restartBroker():void{ /* No state reset, no second launch. */ }
}
function fixture(mode:Mode='CORE',id:string=IDS[0]){
  const r=request(id,mode),c=context(mode),o=new TestOnlyDurableOracle();
  assert.equal(o.reserve(r,c),true);
  return {r,c,o};
}
function launched(mode:Mode='CORE'){
  const f=fixture(mode);
  const signedDispatch=receipt(f.r,'witness','DISPATCH',1,ROOT_END-1);
  assert.equal(f.o.launch(f.r,f.c,signedDispatch),true);
  assert.equal(f.o.state(f.r),'MUTATION_UNKNOWN');
  return f;
}

test('pre-dispatch revoke: no unsigned cancellation; signed no-send receipt fences requestId',()=>{
  const {r,c,o}=fixture();
  c.ownerRevoked=true;
  assert.equal(gate(r,c).reason,'GRANT_REVOKED');
  assert.equal(o.cancel(r),'RESERVED');
  assert.equal(o.cancel(r,receipt(r,'broker','RESERVE',1,ROOT_END,'NO_EFFECT')),'RESERVED');
  assert.equal(o.cancel(r,receipt(r,'witness','RESERVE',1,ROOT_END,'NO_EFFECT')),
    'CANCELLED_NO_EFFECT');
  assert.equal(o.launch(r,c,receipt(r,'witness','DISPATCH',2,ROOT_END-1)),false);
  assert.equal(o.syntheticDispatchEvents.length,0);
});

test('after launch then Broker crash: duplicated identical ACK cannot prove postcondition',()=>{
  const {r,c,o}=launched();
  o.restartBroker();
  const ack=receipt(r,'broker','ACK',2,ROOT_END+10);
  for(let n=0;n<6;n++){
    assert.equal(o.ack(r,ack),'MUTATION_UNKNOWN');
    assert.equal(o.cancel(r),'MUTATION_UNKNOWN');
    assert.equal(o.reserve(r,c),false);
    assert.equal(o.launch(r,c,receipt(r,'witness','DISPATCH',3,ROOT_END-1)),false);
  }
  assert.deepEqual(o.syntheticDispatchEvents,['synthetic-launch:'+r.requestId]);
  assert.equal(o.state(r),'MUTATION_UNKNOWN');
});

test('two contradictory broker-signed duplicate ACKs after crash quarantine receipt, never auto-replay',()=>{
  const {r,c,o}=launched();
  const first=receipt(r,'broker','ACK',2,ROOT_END+1);
  const competing=receipt(r,'broker','ACK',2,ROOT_END+2);
  assert.equal(o.ack(r,first),'MUTATION_UNKNOWN');
  o.restartBroker();
  assert.equal(o.ack(r,competing),'MUTATION_UNKNOWN');
  assert.equal(o.hasConflict(r),true);
  assert.equal(o.observe(r,receipt(r,'observer','READBACK',3,ROOT_END+3,'EFFECT')),
    'MUTATION_UNKNOWN');
  assert.equal(o.reserve(r,c),false);
  assert.equal(o.syntheticDispatchEvents.length,1);
});

test('lost ACK followed by owner re-pair cannot inherit old requestId or signature scope',()=>{
  const {r,c,o}=launched();
  o.restartBroker();o.online=false;
  assert.equal(o.ack(r,receipt(r,'broker','ACK',2,ROOT_END+1)),'MUTATION_UNKNOWN');
  o.online=true;
  c.authoritativeOwnerEpoch=26;c.ownerAccountId='owner-26';
  c.credentialBinding=SHA_C;
  assert.equal(gate(r,c).reason,'WRONG_DEVICE_OR_OWNER_EPOCH');
  assert.equal(o.reserve(r,c),false);
  assert.equal(o.cancel(r),'MUTATION_UNKNOWN');
  assert.equal(o.observe(r,receipt(r,'observer','READBACK',3,ROOT_END+2,'EFFECT',
    SHA_A,strangerSigner.privateKey)),'MUTATION_UNKNOWN');
  assert.equal(o.state(r),'MUTATION_UNKNOWN');
});

test('readback provider unavailable or unsigned claim never promotes UNKNOWN',()=>{
  const {r,c,o}=launched();
  assert.equal(o.observe(r,null),'MUTATION_UNKNOWN');
  assert.equal(o.observe(r,receipt(r,'broker','READBACK',2,ROOT_END+1,'EFFECT')),
    'MUTATION_UNKNOWN');
  assert.equal(o.observe(r,receipt(r,'observer','READBACK',2,ROOT_END+1,'UNAVAILABLE')),
    'MUTATION_UNKNOWN');
  o.online=false;
  assert.equal(o.observe(r,receipt(r,'observer','READBACK',3,ROOT_END+2,'EFFECT')),
    'MUTATION_UNKNOWN');
  c.pendingMutationUnknown=true;
  assert.equal(gate(r,c).reason,'UNKNOWN_MUTATION_NO_REPLAY');
  assert.equal(gate(r,c).automaticallyRetryable,false);
  assert.equal(o.reserve(r,c),false);
  o.online=true;
  assert.equal(o.state(r),'MUTATION_UNKNOWN');
});

test('independent immutable readback: wrong signer, swapped digest, wrong scope and stale seq fail',()=>{
  const {r,o}=launched();
  const good=receipt(r,'observer','READBACK',3,ROOT_END+3,'EFFECT');
  assert.equal(o.observe(r,{...good,signature:'!'}),'MUTATION_UNKNOWN');
  assert.equal(o.observe(r,receipt(r,'observer','READBACK',3,ROOT_END+3,'EFFECT',
    SHA_A,strangerSigner.privateKey)),'MUTATION_UNKNOWN');
  assert.equal(o.observe(r,{...good,outputSha256:SHA_B}),'MUTATION_UNKNOWN');
  assert.equal(o.observe(r,{...good,scope:{...good.scope,ownerEpoch:26}}),'MUTATION_UNKNOWN');
  assert.equal(o.observe(r,{...good,launchId:'different'}),'MUTATION_UNKNOWN');
  assert.equal(o.observe(r,receipt(r,'observer','READBACK',1,ROOT_END+3,'EFFECT')),
    'MUTATION_UNKNOWN');
  assert.equal(o.state(r),'MUTATION_UNKNOWN');
  assert.equal(o.observe(r,good),'EFFECT_VERIFIED');
  assert.equal(o.cancel(r),'EFFECT_VERIFIED');
});

test('ROOT expiry at exact trusted dispatch boundary blocks fresh elevated side effects',()=>{
  const {r,c,o}=fixture('ROOT');
  assert.equal(candidate(r,c),true); // at 899999 ms
  c.now=new Date(ROOT_END);         // exactly 900000 ms
  const signedBackdated=receipt(r,'witness','DISPATCH',1,ROOT_END-1);
  assert.equal(authentic(signedBackdated,'witness'),true);
  assert.equal(o.launch(r,c,signedBackdated),false);
  assert.equal(o.launch(r,c,receipt(r,'witness','DISPATCH',1,ROOT_END)),false);
  assert.equal(o.state(r),'RESERVED');
  assert.equal(gate(r,c).automaticallyRetryable,false);
  assert.equal(o.cancel(r),'RESERVED');
  assert.equal(o.cancel(r,receipt(r,'witness','RESERVE',1,ROOT_END,'NO_EFFECT')),
    'CANCELLED_NO_EFFECT');
  assert.equal(o.syntheticDispatchEvents.length,0);
});

test('ROOT expiry after synthetic launch does not cancel historical OS side effect',()=>{
  const {r,c,o}=launched('ROOT');
  c.now=new Date(ROOT_END);
  c.pendingMutationUnknown=true;
  assert.equal(candidate(r,c),false);
  assert.equal(o.cancel(r),'MUTATION_UNKNOWN');
  assert.equal(o.ack(r,receipt(r,'broker','ACK',2,ROOT_END+1)),'MUTATION_UNKNOWN');
  assert.equal(o.observe(r,receipt(r,'observer','READBACK',3,ROOT_END+2,'UNAVAILABLE')),
    'MUTATION_UNKNOWN');
  assert.equal(o.reserve(r,c),false);
  assert.equal(o.syntheticDispatchEvents.length,1);
});

test('valid CORE enrollment allows independent requests without repeated per-command UAC',()=>{
  const c=context('CORE'),o=new TestOnlyDurableOracle();
  for(const id of [IDS[0],IDS[1]]){
    const r=request(id,'CORE');
    assert.equal(gate(r,c).requiresPerCommandUac,false);
    assert.equal(candidate(r,c),true);
    assert.equal(o.reserve(r,c),true);
    assert.equal(o.launch(r,c,receipt(r,'witness','DISPATCH',1,ROOT_END-1)),true);
  }
  assert.equal(o.syntheticDispatchEvents.length,2);
  c.localBootstrap.signedEnrollmentStoredInProtectedBroker=false;
  const third=request(IDS[2],'CORE');
  assert.equal(gate(third,c).reason,'LOCAL_ONE_TIME_UAC_BOOTSTRAP_UNVERIFIED');
  assert.equal(gate(third,c).requiresPerCommandUac,false);
  assert.equal(o.reserve(third,c),false);
});
