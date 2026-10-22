/**
 * NEXOWIRE P0 #25, independent release acceptance ONLY.
 *
 * #731/#747 reproduce the actual #712 source-order late permit gap.
 * #757 reads Access/CAS twice but does not implement a native atomic commit.
 * This test addresses a DIFFERENT missing invariant: for the SAME already
 * reserved, correctly signed permit, the external revoke-start and the
 * irreversible native-effect commit MUST have one linearization order.
 * After a possible effect, lost OS ACK and UNAVAILABLE authenticated immutable
 * readback require MUTATION_UNKNOWN even after an owner re-pair/drained ACK.
 *
 * ALL I/O, identities, CAS, two Hubs, OS effects and readbacks here are
 * deterministic, IN-MEMORY FAKES. Only Ed25519 crypto is real.
 * Neither #712 nor #757 is merged into this #25 stacked test branch.
 * Do not treat a passing test as a fix to either owner implementation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign,verify} from 'node:crypto';
import {CORE_EXECUTOR_DISPATCH_ENABLED} from
  '../src/security/core-broker-executor-contract.js';

const permitIssuer=generateKeyPairSync('ed25519');
const ROOT_START=Date.parse('2026-10-22T00:00:00.000Z');
const ROOT_END=ROOT_START+900_000;
const OLD_REQUEST='fd126d10-d1ab-4fa9-baad-fd1925006025';
const NEW_REQUEST='fd126d10-d1ab-4fa9-baad-fd1925006026';
type Mode='CORE'|'ROOT';
interface Scope {
  ownerId:string;deviceId:string;sessionEpoch:string;
  ownerEpoch:number;grantGeneration:number;credentialHash:string;
  requestId:string;mode:Mode;
}
interface PermitBody {
  domain:'qa25.atomic-commit.v1';scope:Scope;issuedAt:number;
  expiresAt:number;challengeNonce:string;dispatchId:string;
}
type Permit=PermitBody&{signature:string};
type EffectState='RESERVED_UNPROVEN_NO_EFFECT'|'MUTATION_UNKNOWN';
interface RecordEntry {scope:Scope;state:EffectState;committedAt:number|null}
const older=(mode:Mode='CORE'):Scope=>({
  ownerId:'owner-A',deviceId:'device-25',sessionEpoch:'session-A',
  ownerEpoch:25,grantGeneration:7,credentialHash:'a'.repeat(64),
  requestId:OLD_REQUEST,mode,
});
function issue(scope:Scope,issuedAt:number):Permit {
  const unsigned:PermitBody={
    domain:'qa25.atomic-commit.v1',scope,issuedAt,expiresAt:issuedAt+5_000,
    challengeNonce:'b'.repeat(64),dispatchId:'dispatch:'+scope.requestId,
  };
  return {...unsigned,signature:sign(null,Buffer.from(JSON.stringify(unsigned)),
    permitIssuer.privateKey).toString('base64url')};
}
function verifies(p:Permit):boolean {
  if(p?.domain!=='qa25.atomic-commit.v1'||
     p.dispatchId!=='dispatch:'+p.scope?.requestId||
     !/^[a-f0-9]{64}$/.test(p.challengeNonce)||
     !/^[A-Za-z0-9_-]{86}$/.test(p.signature))return false;
  const bytes=Buffer.from(p.signature,'base64url');
  if(bytes.length!==64||bytes.toString('base64url')!==p.signature)return false;
  const {signature:_discard,...unsigned}=p;
  return verify(null,Buffer.from(JSON.stringify(unsigned)),
    permitIssuer.publicKey,bytes);
}
function sameScope(a:Scope,b:Scope):boolean {
  return JSON.stringify(a)===JSON.stringify(b);
}
function latch(){
  let release!:()=>void;
  const promise=new Promise<void>(resolve=>{release=resolve});
  return {promise,release:()=>release()};
}
/**
 * One SHARED oracle, not process-local Hub flags. A source specification for
 * externally linearizable reserve/revoke/commit, NOT a deployed native CAS.
 */
class SharedExternalCommitOracle {
  ownerId='owner-A';
  ownerEpoch=25;
  generation=7;
  sessionEpoch='session-A';
  credentialHash='a'.repeat(64);
  revoking=false;
  revoked=false;
  readonly history=new Map<string,RecordEntry>();
  readonly syntheticNativeEffects:string[]=[];
  private isOwnerCurrent(s:Scope):boolean {
    return !this.revoking&&!this.revoked&&s.ownerId===this.ownerId&&
      s.ownerEpoch===this.ownerEpoch&&s.grantGeneration===this.generation&&
      s.sessionEpoch===this.sessionEpoch&&
      s.credentialHash===this.credentialHash&&s.deviceId==='device-25';
  }
  reserve(s:Scope,now:number):Permit|null {
    if(!this.isOwnerCurrent(s)||this.history.has(s.requestId)||
       s.mode==='ROOT'&&now>=ROOT_END)return null;
    this.history.set(s.requestId,{
      scope:s,state:'RESERVED_UNPROVEN_NO_EFFECT',committedAt:null,
    });
    return issue(s,now);
  }
  /**
   * MUST run as one externally serialized operation with revoke-start,
   * immediately before native irreversible dispatch.
   */
  atomicCommitAtEffectBoundary(permit:Permit,now:number):boolean {
    const s=permit.scope,entry=this.history.get(s.requestId);
    if(!verifies(permit)||!entry||entry.committedAt!==null||
       !sameScope(s,entry.scope)||!this.isOwnerCurrent(s)||
       permit.issuedAt>now||now>=permit.expiresAt||
       s.mode==='ROOT'&&now>=ROOT_END)return false;
    // Durable UNKNOWN must be written BEFORE possible native effect.
    entry.state='MUTATION_UNKNOWN';
    entry.committedAt=now;
    this.syntheticNativeEffects.push('native-effect:'+s.requestId);
    return true;
  }
  atomicRevokeStart():void {
    // Synchronously serialized with atomicCommitAtEffectBoundary.
    this.revoking=true;
  }
  drainAckLost():void {
    this.revoked=true;
    this.revoking=false;
    this.generation++;
    // Neither the drain nor ACK loss can undo an already-started effect.
  }
  rePairOtherOwner():void {
    this.ownerId='owner-B';this.ownerEpoch=26;
    this.generation=9;this.sessionEpoch='session-B';
    this.credentialHash='c'.repeat(64);
    this.revoked=false;
  }
  readImmutablePostcondition(
    s:Scope,kind:'UNAVAILABLE'|'MISSING'|'STORED_ACK_ONLY',
  ):EffectState|null {
    const entry=this.history.get(s.requestId);
    if(!entry||!sameScope(entry.scope,s))return null;
    assert.ok(['UNAVAILABLE','MISSING','STORED_ACK_ONLY'].includes(kind));
    // No authenticated independently immutable OS readback was supplied.
    return entry.state;
  }
  reusedIdBlocked(s:Scope):boolean{return this.history.has(s.requestId)}
  getState(s:Scope):EffectState|null {
    const e=this.history.get(s.requestId);
    return e&&sameScope(e.scope,s)?e.state:null;
  }
}
function foreign(old:Scope,id=old.requestId):Scope {
  return {...old,ownerId:'owner-B',ownerEpoch:26,grantGeneration:9,
    sessionEpoch:'session-B',credentialHash:'c'.repeat(64),requestId:id};
}
class SyntheticHub {
  constructor(readonly name:'Hub-A'|'Hub-B',
    readonly authority:SharedExternalCommitOracle){}
  dispatch(p:Permit,now:number):boolean {
    return this.authority.atomicCommitAtEffectBoundary(p,now);
  }
  revokeStart():void {this.authority.atomicRevokeStart()}
}

test('NEW ORDERING: Hub B revoke-start wins AFTER A reserve, BEFORE final native commit; valid late permit stays reserved, not cancelled',async()=>{
  assert.equal(CORE_EXECUTOR_DISPATCH_ENABLED,false);
  const cas=new SharedExternalCommitOracle();
  const a=new SyntheticHub('Hub-A',cas),b=new SyntheticHub('Hub-B',cas);
  const s=older(),reservedAt=ROOT_START+42_000;
  const permit=cas.reserve(s,reservedAt);
  assert.ok(permit);
  const deliver=latch(),waiting=latch();
  const pending=(async()=>{
    waiting.release();
    await deliver.promise;
    return a.dispatch(permit,reservedAt+2);
  })();
  await waiting.promise;
  b.revokeStart(); // actual linearization is BEFORE effect commit
  assert.equal(verifies(permit),true,'original Ed25519 permit is authentic');
  deliver.release();
  assert.equal(await pending,false,'revoke-start must win final CAS commit');
  assert.equal(cas.syntheticNativeEffects.length,0);
  // No independent signed never-sent proof: RESERVED isn't CANCELLED.
  assert.equal(cas.readImmutablePostcondition(s,'UNAVAILABLE'),
    'RESERVED_UNPROVEN_NO_EFFECT');
  cas.drainAckLost();cas.rePairOtherOwner();
  assert.equal(cas.reusedIdBlocked(foreign(s)),true);
  assert.equal(cas.reserve(foreign(s),reservedAt+3),null);
  assert.equal(cas.getState(s),'RESERVED_UNPROVEN_NO_EFFECT');
});

test('NEW ORDERING: Hub A commits effect BEFORE Hub B revoke-start; crash/lost OS ACK/readback unavailable remains UNKNOWN across foreign owner',async()=>{
  const cas=new SharedExternalCommitOracle();
  const a=new SyntheticHub('Hub-A',cas),b=new SyntheticHub('Hub-B',cas);
  const s=older(),t=ROOT_START+42_000;
  const p=cas.reserve(s,t);
  assert.ok(p);
  assert.equal(a.dispatch(p,t+1),true,
    'effect commit linearizes before remote revoke-start');
  b.revokeStart();
  assert.equal(verifies(p),true);
  // OS result/ACK and immutable observer response are lost independently.
  for(const missing of ['UNAVAILABLE','MISSING','STORED_ACK_ONLY'] as const){
    assert.equal(cas.readImmutablePostcondition(s,missing),'MUTATION_UNKNOWN');
  }
  cas.drainAckLost(); // drained claim != effect reversed
  assert.equal(cas.getState(s),'MUTATION_UNKNOWN');
  cas.rePairOtherOwner();
  assert.equal(cas.readImmutablePostcondition(s,'UNAVAILABLE'),
    'MUTATION_UNKNOWN');
  assert.equal(cas.reserve(foreign(s),t+2),null);
  assert.equal(a.dispatch(p,t+2),false,'old signed permit cannot replay');
  const newOwnerRequest=foreign(s,NEW_REQUEST);
  const fresh=cas.reserve(newOwnerRequest,t+2);
  assert.ok(fresh,'new unrelated request may reserve after a real re-pair');
  assert.equal(cas.syntheticNativeEffects.length,1);
  assert.equal(cas.getState(s),'MUTATION_UNKNOWN');
});

test('ROOT T+900000ms: correctly signed T-1 permit cannot commit at deadline, irrespective of stale prior Access reviews',()=>{
  const s=older('ROOT'),issued=ROOT_END-1,delivered=ROOT_END;
  const cas=new SharedExternalCommitOracle();
  const a=new SyntheticHub('Hub-A',cas);
  const p=cas.reserve(s,issued);
  assert.ok(p);
  assert.equal(verifies(p),true);
  assert.equal(a.dispatch(p,delivered),false);
  assert.equal(cas.getState(s),'RESERVED_UNPROVEN_NO_EFFECT');
  assert.equal(cas.syntheticNativeEffects.length,0);
  // Contrast commit one millisecond before deadline followed by expiry:
  const cas2=new SharedExternalCommitOracle(),a2=new SyntheticHub('Hub-A',cas2);
  const p2=cas2.reserve(s,issued);
  assert.ok(p2);
  assert.equal(a2.dispatch(p2,issued),true);
  cas2.atomicRevokeStart();
  cas2.drainAckLost();
  assert.equal(cas2.readImmutablePostcondition(s,'UNAVAILABLE'),
    'MUTATION_UNKNOWN','ROOT expiry/revoke cannot undo launched effect');
  assert.equal(cas2.syntheticNativeEffects.length,1);
});


test('#780 checkpoint stop: readback required after ambiguous commit and current owner epoch required before any resume or requestId substitution',()=>{
  // TEST-ONLY loop acceptance; #780 is a P1 epic, not an implemented runner.
  // This uses the same durable in-memory journal as the prior CAS tests.
  // ACK, pid exit, release and publisher receipts are NOT immutable effect proof.
  type Checkpoint={
    taskId:string;requestId:string;ownerId:string;ownerEpoch:number;
    grantGeneration:number;sessionEpoch:string;deviceId:string;
    capability:string;effectFingerprint:string;nextStep:number;
  };
  type Stop={
    state:'RECONCILE_REQUIRED';reason:
      'READBACK_REQUIRED'|'CURRENT_OWNER_EPOCH_REQUIRED'|
      'IMMUTABLE_REQUEST_ID_MISMATCH';
    mayRetry:false;mayAdvanceCheckpoint:false;mayRefundQuota:false;
    readbackRequired:true;
  };
  const task='qa25-synthetic-coding-task';
  const fingerprint='e'.repeat(64);
  function checkpoint(s:Scope):Checkpoint{
    return {
      taskId:task,requestId:s.requestId,ownerId:s.ownerId,
      ownerEpoch:s.ownerEpoch,grantGeneration:s.grantGeneration,
      sessionEpoch:s.sessionEpoch,deviceId:s.deviceId,
      capability:'core.process.start',effectFingerprint:fingerprint,
      nextStep:4,
    };
  }
  function stopForResume(
    cas:SharedExternalCommitOracle,staged:Checkpoint,
    immutable:Checkpoint,readback:'UNAVAILABLE'|'BROKER_ACK_ONLY',
  ):Stop{
    const base={state:'RECONCILE_REQUIRED' as const,mayRetry:false as const,
      mayAdvanceCheckpoint:false as const,mayRefundQuota:false as const,
      readbackRequired:true as const};
    const immutableKeys=[
      'taskId','requestId','ownerId','ownerEpoch','grantGeneration',
      'sessionEpoch','deviceId','capability','effectFingerprint',
    ] as const;
    const history=cas.history.get(immutable.requestId);
    if(!history||immutableKeys.some(k=>staged[k]!==immutable[k])||
       staged.nextStep!==immutable.nextStep||
       staged.requestId!==history.scope.requestId||
       staged.ownerId!==history.scope.ownerId||
       staged.deviceId!==history.scope.deviceId||
       staged.ownerEpoch!==history.scope.ownerEpoch||
       staged.grantGeneration!==history.scope.grantGeneration||
       staged.sessionEpoch!==history.scope.sessionEpoch){
      return {...base,reason:'IMMUTABLE_REQUEST_ID_MISMATCH'};
    }
    // Reauthorization must be current from the independent epoch authority.
    // A restored checkpoint itself is NOT an owner-epoch authority.
    if(cas.ownerId!==immutable.ownerId||
       cas.ownerEpoch!==immutable.ownerEpoch||
       cas.generation!==immutable.grantGeneration||
       cas.sessionEpoch!==immutable.sessionEpoch||
       cas.revoking||cas.revoked){
      return {...base,reason:'CURRENT_OWNER_EPOCH_REQUIRED'};
    }
    assert.ok(readback==='UNAVAILABLE'||readback==='BROKER_ACK_ONLY');
    // Both reserved/never-sent-unproven and committed/ACK-lost states
    // need an authenticated independent immutable readback before resume.
    assert.ok(history.state==='MUTATION_UNKNOWN'||
      history.state==='RESERVED_UNPROVEN_NO_EFFECT');
    return {...base,reason:'READBACK_REQUIRED'};
  }

  assert.equal(CORE_EXECUTOR_DISPATCH_ENABLED,false);
  const when=ROOT_START+42_000;

  // Revocation wins after reserve: ZERO effect; without independent no-send
  // proof, the coding loop still must not claim cancellation or resume.
  const first=new SharedExternalCommitOracle(),s=older();
  const stalePermit=first.reserve(s,when);
  assert.ok(stalePermit);
  const firstCheckpoint=checkpoint(s);
  assert.equal(stopForResume(first,firstCheckpoint,firstCheckpoint,'UNAVAILABLE').reason,
    'READBACK_REQUIRED');
  first.atomicRevokeStart();
  assert.equal(first.atomicCommitAtEffectBoundary(stalePermit,when+1),false);
  assert.equal(first.syntheticNativeEffects.length,0);
  assert.equal(stopForResume(first,firstCheckpoint,firstCheckpoint,'BROKER_ACK_ONLY').reason,
    'CURRENT_OWNER_EPOCH_REQUIRED');
  assert.equal(first.getState(s),'RESERVED_UNPROVEN_NO_EFFECT');

  // Other linearization: effect committed, then ACK lost and independent
  // readback unavailable. A restored checkpoint must stop, never replay.
  const second=new SharedExternalCommitOracle();
  const p=second.reserve(s,when);
  assert.ok(p);
  const durable=checkpoint(s);
  assert.equal(second.atomicCommitAtEffectBoundary(p,when+1),true);
  const originalEffectCount=second.syntheticNativeEffects.length;
  for(const witness of ['UNAVAILABLE','BROKER_ACK_ONLY'] as const){
    const decision=stopForResume(second,durable,durable,witness);
    assert.deepEqual(decision,{
      state:'RECONCILE_REQUIRED',reason:'READBACK_REQUIRED',
      mayRetry:false,mayAdvanceCheckpoint:false,mayRefundQuota:false,
      readbackRequired:true,
    });
  }
  second.atomicRevokeStart();
  second.drainAckLost(); // Drain receipt != OS postcondition.
  second.rePairOtherOwner();
  assert.equal(stopForResume(second,durable,durable,'UNAVAILABLE').reason,
    'CURRENT_OWNER_EPOCH_REQUIRED');
  assert.equal(stopForResume(second,{
    ...durable,ownerId:'owner-B',ownerEpoch:26,grantGeneration:9,
    sessionEpoch:'session-B',requestId:NEW_REQUEST,nextStep:5,
  },durable,'UNAVAILABLE').reason,'IMMUTABLE_REQUEST_ID_MISMATCH');
  assert.equal(second.readImmutablePostcondition(s,'UNAVAILABLE'),'MUTATION_UNKNOWN');
  assert.equal(second.atomicCommitAtEffectBoundary(p,when+2),false);
  assert.equal(second.syntheticNativeEffects.length,originalEffectCount);
  assert.equal(second.history.size,1,'resume created no replacement request or checkpoint');
  assert.equal(second.getState(s),'MUTATION_UNKNOWN');
});


test('#781 cross-Hub restart: semantic mutation identity survives signed journal serialization, stale epoch and ACK loss without replay',()=>{
  // Independent SPECIFICATION ONLY: the real executeDurableRunbook unsafe
  // duplicate found in #781 remains RED at the production-source boundary.
  // This test does not replace or patch that implementation.
  type PersistentEffect={
    schema:'qa25.mock-independent-journal.v1';
    semanticMutationSha:string;originalRequestId:string;
    ownerId:string;ownerEpoch:number;grantGeneration:number;
    sessionEpoch:string;deviceId:string;effectState:EffectState;
    committedAt:number|null;
  };
  type SignedSnapshot={payload:PersistentEffect;signature:string};
  type CurrentAuthority={
    ownerId:string;ownerEpoch:number;grantGeneration:number;
    sessionEpoch:string;revoking:boolean;
  };
  type ResumeDisposition=
    'READBACK_REQUIRED'|'CURRENT_OWNER_EPOCH_REQUIRED'|
    'IMMUTABLE_REQUEST_ID_CONFLICT'|'FORENSIC_SNAPSHOT_UNTRUSTED';

  // The semantic SHA intentionally EXCLUDES runbook_id and graph_id. A
  // cloned runbook naming the same native mutation cannot mint new identity.
  const operation={
    deviceId:'device-25',capability:'core.process.start',
    payloadSha256:'d'.repeat(64),stableStepId:'native-effect-4',
  };
  const semanticSha=createHash('sha256')
    .update(JSON.stringify(operation)).digest('hex');
  const journalSigner=generateKeyPairSync('ed25519');
  const at=ROOT_START+43_000;
  const s=older();
  const originalRunbook='runbook-before-crash';
  const clonedRunbook='runbook-cloned-after-crash';
  assert.notEqual(originalRunbook,clonedRunbook);

  function save(cas:SharedExternalCommitOracle):string{
    const e=cas.history.get(s.requestId);
    assert.ok(e,'an independently journaled reservation is mandatory');
    const payload:PersistentEffect={
      schema:'qa25.mock-independent-journal.v1',
      semanticMutationSha:semanticSha,originalRequestId:e.scope.requestId,
      ownerId:e.scope.ownerId,ownerEpoch:e.scope.ownerEpoch,
      grantGeneration:e.scope.grantGeneration,
      sessionEpoch:e.scope.sessionEpoch,deviceId:e.scope.deviceId,
      effectState:e.state,committedAt:e.committedAt,
    };
    const signature=sign(null,Buffer.from(JSON.stringify(payload)),
      journalSigner.privateKey).toString('base64url');
    return JSON.stringify({payload,signature} satisfies SignedSnapshot);
  }
  function restart(serialized:string):SignedSnapshot{
    // Fresh object after an explicit JSON serialization boundary; never
    // trust a checkpoint field as current owner-epoch authority.
    const saved=JSON.parse(serialized) as SignedSnapshot;
    assert.ok(saved!==null&&typeof saved==='object');
    return saved;
  }
  function forensicValid(j:SignedSnapshot):boolean{
    if(j.payload?.schema!=='qa25.mock-independent-journal.v1'||
       typeof j.signature!=='string'||!(/^[A-Za-z0-9_-]{86}$/).test(j.signature))
      return false;
    const sig=Buffer.from(j.signature,'base64url');
    return sig.length===64&&sig.toString('base64url')===j.signature&&
      verify(null,Buffer.from(JSON.stringify(j.payload)),
        journalSigner.publicKey,sig);
  }
  function tryResume(
    saved:SignedSnapshot,logicalSha:string,
    proposedRequestId:string,proposedOwnerEpoch:number,
    current:CurrentAuthority,
    independentReadback:'UNAVAILABLE'|'BROKER_ACK_ONLY',
  ):ResumeDisposition{
    if(!forensicValid(saved)||saved.payload.semanticMutationSha!==logicalSha)
      return 'FORENSIC_SNAPSHOT_UNTRUSTED';
    if(proposedRequestId!==saved.payload.originalRequestId)
      return 'IMMUTABLE_REQUEST_ID_CONFLICT';
    if(proposedOwnerEpoch!==current.ownerEpoch||
       saved.payload.ownerEpoch!==current.ownerEpoch||
       saved.payload.ownerId!==current.ownerId||
       saved.payload.grantGeneration!==current.grantGeneration||
       saved.payload.sessionEpoch!==current.sessionEpoch||
       current.revoking)
      return 'CURRENT_OWNER_EPOCH_REQUIRED';
    assert.ok(independentReadback==='UNAVAILABLE'||
      independentReadback==='BROKER_ACK_ONLY');
    assert.ok(saved.payload.effectState==='MUTATION_UNKNOWN'||
      saved.payload.effectState==='RESERVED_UNPROVEN_NO_EFFECT');
    return 'READBACK_REQUIRED';
  }
  const currentOld:CurrentAuthority={
    ownerId:'owner-A',ownerEpoch:25,grantGeneration:7,
    sessionEpoch:'session-A',revoking:false,
  };
  const currentRevoked:CurrentAuthority={
    ...currentOld,revoking:true,
  };
  const currentNew:CurrentAuthority={
    ownerId:'owner-B',ownerEpoch:26,grantGeneration:9,
    sessionEpoch:'session-B',revoking:false,
  };
  const clonedId=NEW_REQUEST;

  // Order A: independently recognized revoke-start wins after reserve;
  // a still signed permit must never become a native effect on a new Hub.
  const before=new SharedExternalCommitOracle();
  const oldPermit=before.reserve(s,at);
  assert.ok(oldPermit);
  before.atomicRevokeStart();
  assert.equal(before.atomicCommitAtEffectBoundary(oldPermit,at+1),false);
  const firstSnapshot=restart(save(before));
  assert.equal(forensicValid(firstSnapshot),true);
  assert.equal(tryResume(firstSnapshot,semanticSha,s.requestId,25,
    currentRevoked,'UNAVAILABLE'),'CURRENT_OWNER_EPOCH_REQUIRED');
  assert.equal(tryResume(firstSnapshot,semanticSha,clonedId,26,
    currentNew,'UNAVAILABLE'),'IMMUTABLE_REQUEST_ID_CONFLICT');
  assert.equal(firstSnapshot.payload.effectState,
    'RESERVED_UNPROVEN_NO_EFFECT');
  assert.equal(before.syntheticNativeEffects.length,0);

  // Order B: native effect commit wins, OS ACK is LOST; Hub B revokes,
  // then a *different process/Hub* reloads the journal and changes runbook
  // name. No readback, no status change, no second effect or quota refund.
  const committed=new SharedExternalCommitOracle();
  const p=committed.reserve(s,at);
  assert.ok(p);
  assert.equal(committed.atomicCommitAtEffectBoundary(p,at+1),true);
  const effectCount=committed.syntheticNativeEffects.length;
  const signedArchive=save(committed);
  committed.atomicRevokeStart();
  committed.drainAckLost();
  committed.rePairOtherOwner();
  const restored=restart(signedArchive);
  assert.equal(restored.payload.originalRequestId,s.requestId);
  assert.equal(restored.payload.semanticMutationSha,semanticSha);
  assert.equal(restored.payload.effectState,'MUTATION_UNKNOWN');
  assert.equal(tryResume(restored,semanticSha,s.requestId,25,
    currentOld,'UNAVAILABLE'),'READBACK_REQUIRED',
  'the original current epoch would still require immutable readback');
  assert.equal(tryResume(restored,semanticSha,s.requestId,25,
    currentNew,'BROKER_ACK_ONLY'),'CURRENT_OWNER_EPOCH_REQUIRED');
  assert.equal(tryResume(restored,semanticSha,clonedId,26,
    currentNew,'UNAVAILABLE'),'IMMUTABLE_REQUEST_ID_CONFLICT',
  'a new runbook_id and requestId do not define a new logical mutation');
  assert.equal(tryResume(restored,'0'.repeat(64),s.requestId,25,
    currentOld,'UNAVAILABLE'),'FORENSIC_SNAPSHOT_UNTRUSTED');
  const forged=restart(signedArchive);
  forged.payload.originalRequestId=clonedId; // invalidates signature
  assert.equal(forensicValid(forged),false);
  assert.equal(tryResume(forged,semanticSha,clonedId,26,
    currentNew,'UNAVAILABLE'),'FORENSIC_SNAPSHOT_UNTRUSTED');
  assert.equal(committed.readImmutablePostcondition(s,'UNAVAILABLE'),
    'MUTATION_UNKNOWN');
  assert.equal(committed.atomicCommitAtEffectBoundary(p,at+2),false);
  assert.equal(committed.syntheticNativeEffects.length,effectCount);
  assert.equal(committed.history.size,1,
    'no cloned or replacement requestId inserted into durable ledger');
});
