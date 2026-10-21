import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CORE_EXECUTOR_DISPATCH_ENABLED,
  evaluateCoreBrokerExecution,
  type CoreBrokerContext,
} from '../src/security/core-broker-executor-contract.js';

/**
 * #25 follow-up: independent SOURCE-ONLY post-launch acceptance fixture.
 * The mocked witness/launch journal is a NEGATIVE-TEST ORACLE, NOT a real CAS
 * or an elevated Windows executor. It never spawns, writes, installs, or
 * requests native consent. Existing PR #633 production dispatch is disabled.
 *
 * A successful gate return of ELEVATED_DISPATCH_NOT_INSTALLED means only that
 * mocked prerequisites reached the disabled-dispatch boundary. This test
 * MUST NOT claim a Windows process started or was genuinely cancelled.
 */
const image='a'.repeat(64), binding='b'.repeat(64), nextBinding='d'.repeat(64);
const device='device-25', owner='owner-25';
const firstId='fd126d10-d1ab-4fa9-baad-fd1925001025';
const secondId='fd126d10-d1ab-4fa9-baad-fd1925001026';
type Mode='CORE'|'ROOT';
type Request=ReturnType<typeof request>;
type State='RESERVED_NO_DISPATCH'|'CANCELLED_NO_EFFECT'|
  'MUTATION_UNKNOWN'|'EFFECT_VERIFIED';

function request(requestId=firstId,mode:Mode='CORE'): {
  type:'core-broker.execute';version:1;requestId:string;
  deviceId:string;ownerAccountId:string;ownerEpoch:number;
  credentialBinding:string;mode:Mode;action:'core.process.start';
  issuedAt:string;expiresAt:string;
  shell:{executable:string;arguments:string[]};
}{
  return {
    type:'core-broker.execute',version:1,requestId,deviceId:device,
    ownerAccountId:owner,ownerEpoch:25,credentialBinding:binding,mode,
    action:'core.process.start',issuedAt:'2026-10-21T12:59:30.000Z',
    expiresAt:'2026-10-21T13:00:00.000Z',
    shell:{executable:'synthetic-not-a-real-executable',arguments:[]},
  };
}
function context(mode:Mode='CORE'):CoreBrokerContext{
  return {
    now:new Date('2026-10-21T12:59:59.999Z'),
    deviceId:device,ownerAccountId:owner,credentialBinding:binding,
    authoritativeOwnerEpoch:25,ownerRevoked:false,
    enrollment:{
      deviceId:device,ownerAccountId:owner,ownerEpoch:25,
      credentialBinding:binding,
      enrollmentId:'c2500000-0000-4000-8000-000000001025',
      activatedAt:mode==='ROOT'
        ?'2026-10-21T12:45:00.000Z'
        :'2026-10-21T12:40:00.000Z',
      expiresAt:mode==='ROOT'?'2026-10-21T13:00:00.000Z':null,
      mode,ownerSignedGrantDigest:'c'.repeat(64),
      brokerInstalledImageSha256:image,
    },
    localBootstrap:{
      localPhysicalUacConsentVerified:true,
      signedEnrollmentStoredInProtectedBroker:true,
      trustedInstallerRollbackBindingVerified:true,
    },
    trustedRuntime:{
      evidenceProvenance:'independent-windows-native',
      brokerProcessHighIntegrity:true,
      administratorsTokenEnabled:true,
      brokerAuthenticatedAndVersionMatched:true,
      runningImageIdentityMatched:true,
      expectedBrokerImageSha256:image,
      imageAuthenticodePublisherPinned:true,
      signedReleaseAndRollbackManifestVerified:true,
      brokerExeAndParentAclProtected:true,
      importedModulesAclProtected:true,
      updaterPathsAclProtected:true,
      processHandleDuplicationBoundaryProtected:true,
    },
    ownerIntentSignatureVerified:true,enrollmentSignatureVerified:true,
    ownerEpochWitnessVerified:true,
    requestAlreadyReserved:()=>false,
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
  assert.equal(result.privilegedExecutionOccurred,false);
  assert.equal(result.verifiedEffect,false);
  assert.equal(result.automaticallyRetryable,false);
  assert.equal(result.oneTimeBootstrapAlreadyVerified,true);
  assert.equal(result.requiresPerCommandUac,false);
}
function latch(){
  let release!:()=>void;
  const promise=new Promise<void>((resolve)=>{release=resolve;});
  return {promise,release:()=>release()};
}
interface Receipt {
  origin:'independent-readback'|'broker-claim'|'client-claim';
  requestId:string;deviceId:string;ownerAccountId:string;
  ownerEpoch:number;credentialBinding:string;launchId:string;
  postcondition:'verified'|'unknown';
}
type JournalEntry={
  requestId:string;deviceId:string;ownerAccountId:string;
  ownerEpoch:number;credentialBinding:string;launchId:string;
  launched:boolean;cancelRequested:boolean;status:State;
};
function proof(r:Request):Receipt{
  return {
    origin:'independent-readback',requestId:r.requestId,
    deviceId:r.deviceId,ownerAccountId:r.ownerAccountId,
    ownerEpoch:r.ownerEpoch,credentialBinding:r.credentialBinding,
    launchId:'launch:'+r.requestId,postcondition:'verified',
  };
}
/**
 * Deliberately tiny in-memory SPECIFICATION, not the production implementation.
 * A real system MUST replace this with off-process monotonic CAS and trusted
 * native process/postcondition observation. All "launches" are array events.
 */
class SimulatedWitness {
  readonly entries=new Map<string,JournalEntry>();
  readonly launchEvents:string[]=[];
  reserve(r:Request,c:CoreBrokerContext):boolean{
    // Global requestId uniqueness, independent of the new owner's epoch.
    if(this.entries.has(r.requestId))return false;
    if(gate(r,c).reason!=='ELEVATED_DISPATCH_NOT_INSTALLED')return false;
    this.entries.set(r.requestId,{
      requestId:r.requestId,deviceId:r.deviceId,
      ownerAccountId:r.ownerAccountId,ownerEpoch:r.ownerEpoch,
      credentialBinding:r.credentialBinding,launchId:'launch:'+r.requestId,
      launched:false,cancelRequested:false,status:'RESERVED_NO_DISPATCH',
    });
    return true;
  }
  launch(r:Request,c:CoreBrokerContext):boolean{
    const entry=this.entries.get(r.requestId);
    if(!entry||entry.launched||entry.cancelRequested)return false;
    if(entry.deviceId!==r.deviceId||entry.ownerAccountId!==r.ownerAccountId||
       entry.ownerEpoch!==r.ownerEpoch||
       entry.credentialBinding!==r.credentialBinding)return false;
    // This is a mocked "fresh fence", NOT atomic with a native OS launch.
    if(gate(r,c).reason!=='ELEVATED_DISPATCH_NOT_INSTALLED')return false;
    entry.launched=true;entry.status='MUTATION_UNKNOWN';
    this.launchEvents.push(r.requestId);
    return true;
  }
  cancel(requestId:string):State{
    const entry=this.entries.get(requestId);
    assert.ok(entry,'reservation required');
    entry.cancelRequested=true;
    // No-dispatch proven only inside this synthetic journal.
    if(!entry.launched&&entry.status==='RESERVED_NO_DISPATCH'){
      entry.status='CANCELLED_NO_EFFECT';
    }
    return entry.status;
  }
  lostAck(requestId:string):State{
    const entry=this.entries.get(requestId);
    assert.ok(entry,'reservation required');
    // Duplicate lost ACK is not a new launch or a cancellation receipt.
    return entry.status;
  }
  postcondition(readback:Receipt):State|undefined{
    const entry=this.entries.get(readback.requestId);
    if(!entry)return undefined;
    if(entry.status==='EFFECT_VERIFIED')return entry.status;
    if(!entry.launched||readback.origin!=='independent-readback'||
       readback.postcondition!=='verified'||
       readback.launchId!==entry.launchId||
       readback.deviceId!==entry.deviceId||
       readback.ownerAccountId!==entry.ownerAccountId||
       readback.ownerEpoch!==entry.ownerEpoch||
       readback.credentialBinding!==entry.credentialBinding){
      return entry.status;
    }
    // Only fixture-trusted independent readback, not exitCode or ACK, promotes.
    entry.status='EFFECT_VERIFIED';
    return entry.status;
  }
  status(id:string):State|undefined{return this.entries.get(id)?.status;}
}

test('post-launch revoke BEFORE readback: cancellation cannot erase possible OS side effect',async()=>{
  const journal=new SimulatedWitness(),r=request(),c=context();
  const entered=latch(),released=latch();
  sourceCandidate(r,c);
  assert.equal(journal.reserve(r,c),true);
  const inFlight=(async()=>{
    assert.equal(journal.launch(r,c),true);
    entered.release();
    await released.promise;
    return journal.status(r.requestId);
  })();
  await entered.promise; // task launch already recorded, no postcondition yet
  c.ownerRevoked=true;
  const gateAfterRevoke=gate(r,c);
  assert.equal(gateAfterRevoke.reason,'GRANT_REVOKED');
  assert.equal(gateAfterRevoke.verifiedEffect,false);
  assert.equal(journal.cancel(r.requestId),'MUTATION_UNKNOWN');
  assert.equal(journal.lostAck(r.requestId),'MUTATION_UNKNOWN');
  released.release();
  assert.equal(await inFlight,'MUTATION_UNKNOWN');
  assert.deepEqual(journal.launchEvents,[r.requestId]);
});

test('prelaunch cancellation has independently distinguishable synthetic no-send proof',()=>{
  const journal=new SimulatedWitness(),r=request(),c=context();
  assert.equal(journal.reserve(r,c),true);
  assert.equal(journal.cancel(r.requestId),'CANCELLED_NO_EFFECT');
  assert.equal(journal.launch(r,c),false);
  assert.equal(journal.lostAck(r.requestId),'CANCELLED_NO_EFFECT');
  assert.deepEqual(journal.launchEvents,[]);
});

test('duplicate ACK loss and repeated cancellation after launch never redispatch',()=>{
  const journal=new SimulatedWitness(),r=request(),c=context();
  assert.equal(journal.reserve(r,c),true);
  assert.equal(journal.launch(r,c),true);
  for(let i=0;i<5;i++){
    assert.equal(journal.lostAck(r.requestId),'MUTATION_UNKNOWN');
    assert.equal(journal.cancel(r.requestId),'MUTATION_UNKNOWN');
    assert.equal(journal.reserve(r,c),false);
    assert.equal(journal.launch(r,c),false);
  }
  c.pendingMutationUnknown=true;
  assert.equal(gate(r,c).reason,'UNKNOWN_MUTATION_NO_REPLAY');
  c.pendingMutationUnknown=false;
  c.requestAlreadyReserved=(id)=>id===r.requestId;
  assert.equal(gate(r,c).reason,'STALE_OR_REPLAYED_REQUEST');
  assert.deepEqual(journal.launchEvents,[r.requestId]);
});

test('late independent postcondition after revoke is historical effect, never cancelled',()=>{
  const journal=new SimulatedWitness(),r=request(),c=context();
  assert.equal(journal.reserve(r,c),true);
  assert.equal(journal.launch(r,c),true);
  c.ownerRevoked=true;
  assert.equal(journal.cancel(r.requestId),'MUTATION_UNKNOWN');
  assert.equal(journal.postcondition({...proof(r),origin:'broker-claim'}),'MUTATION_UNKNOWN');
  assert.equal(journal.postcondition({...proof(r),postcondition:'unknown'}),'MUTATION_UNKNOWN');
  assert.equal(journal.postcondition(proof(r)),'EFFECT_VERIFIED');
  assert.equal(journal.cancel(r.requestId),'EFFECT_VERIFIED');
  assert.equal(journal.postcondition(proof(r)),'EFFECT_VERIFIED'); // duplicate
  assert.equal(journal.launchEvents.length,1);
  assert.equal(gate(r,c).reason,'GRANT_REVOKED'); // cannot launch another
});

test('owner re-pair during in-flight old job: old scope never inherits new grant',async()=>{
  const journal=new SimulatedWitness(),old=request(),c=context();
  assert.equal(journal.reserve(old,c),true);
  const started=latch(),resume=latch();
  const work=(async()=>{
    assert.equal(journal.launch(old,c),true);
    started.release();
    await resume.promise;
    return journal.status(old.requestId);
  })();
  await started.promise;
  c.ownerAccountId='owner-26';
  c.authoritativeOwnerEpoch=26;
  c.credentialBinding=nextBinding;
  assert.equal(gate(old,c).reason,'WRONG_DEVICE_OR_OWNER_EPOCH');
  assert.equal(journal.cancel(old.requestId),'MUTATION_UNKNOWN');
  resume.release();
  assert.equal(await work,'MUTATION_UNKNOWN');

  const newer:Request={...old,requestId:secondId,ownerAccountId:'owner-26',
    ownerEpoch:26,credentialBinding:nextBinding};
  c.enrollment={...c.enrollment!,ownerAccountId:'owner-26',
    ownerEpoch:26,credentialBinding:nextBinding,
    enrollmentId:'c2600000-0000-4000-8000-000000001026'};
  // Old request ID remains used, despite fully new signed enrollment scope.
  const stolen:Request={...newer,requestId:old.requestId};
  assert.equal(journal.reserve(stolen,c),false);
  assert.equal(journal.launch(stolen,c),false);
  assert.equal(journal.reserve(newer,c),true);
  assert.equal(journal.launch(newer,c),true);
  assert.deepEqual(journal.launchEvents,[old.requestId,newer.requestId]);

  // A forged "new owner success" cannot reattribute old action; historical
  // independent proof may only attest effect under original scope.
  assert.equal(journal.postcondition({...proof(old),
    ownerAccountId:'owner-26',ownerEpoch:26,
    credentialBinding:nextBinding}),'MUTATION_UNKNOWN');
  assert.equal(journal.postcondition(proof(old)),'EFFECT_VERIFIED');
  assert.equal(journal.status(newer.requestId),'MUTATION_UNKNOWN');
});

test('ROOT expires DURING already-launched job at exactly 900000ms: UNKNOWN, no restart',()=>{
  const journal=new SimulatedWitness(),r=request(firstId,'ROOT'),c=context('ROOT');
  c.now=new Date('2026-10-21T12:59:59.999Z');
  sourceCandidate(r,c);
  assert.equal(journal.reserve(r,c),true);
  assert.equal(journal.launch(r,c),true);
  assert.equal(journal.status(r.requestId),'MUTATION_UNKNOWN');
  c.now=new Date('2026-10-21T13:00:00.000Z');
  const atBoundary=gate(r,c);
  // Admission checks request expiry before ROOT expiry; both deny.
  assert.ok(['GRANT_NOT_ACTIVE','ROOT_15_MINUTES_EXCEEDED'].includes(atBoundary.reason));
  assert.equal(atBoundary.automaticallyRetryable,false);
  assert.equal(journal.cancel(r.requestId),'MUTATION_UNKNOWN');
  assert.equal(journal.launch(r,c),false);
  c.now=new Date('2026-10-21T13:00:00.001Z');
  assert.equal(journal.status(r.requestId),'MUTATION_UNKNOWN');
  assert.equal(journal.launchEvents.length,1);

  // A fresh request that extends past ROOT expiry is rejected even BEFORE it.
  const extended:Request={...r,requestId:secondId,
    expiresAt:'2026-10-21T13:00:20.000Z'};
  c.now=new Date('2026-10-21T12:59:59.999Z');
  assert.equal(gate(extended,c).reason,'ROOT_15_MINUTES_EXCEEDED');
});

test('postcondition frauds: wrong launch, identity, epoch, pending/claimed receipt stay UNKNOWN',()=>{
  const journal=new SimulatedWitness(),r=request(),c=context();
  assert.equal(journal.reserve(r,c),true);
  assert.equal(journal.launch(r,c),true);
  const bad:Receipt[]=[
    {...proof(r),origin:'client-claim'},
    {...proof(r),origin:'broker-claim'},
    {...proof(r),launchId:'wrong-launch'},
    {...proof(r),deviceId:'other-device'},
    {...proof(r),ownerAccountId:'new-owner'},
    {...proof(r),ownerEpoch:26},
    {...proof(r),credentialBinding:nextBinding},
    {...proof(r),postcondition:'unknown'},
    {...proof(r),requestId:secondId},
  ];
  for(const receipt of bad){
    const state=journal.postcondition(receipt);
    assert.ok(state===undefined||state==='MUTATION_UNKNOWN');
    assert.equal(journal.status(r.requestId),'MUTATION_UNKNOWN');
  }
  assert.equal(journal.postcondition(proof(r)),'EFFECT_VERIFIED');
  assert.equal(journal.launchEvents.length,1);
});

test('two CORE commands share one valid enrollment, never extra per-command UAC',()=>{
  const journal=new SimulatedWitness(),c=context();
  for(const id of [firstId,secondId]){
    const r=request(id);
    sourceCandidate(r,c);
    assert.equal(journal.reserve(r,c),true);
    assert.equal(journal.launch(r,c),true);
  }
  assert.deepEqual(journal.launchEvents,[firstId,secondId]);
  assert.equal(c.localBootstrap.localPhysicalUacConsentVerified,true);
  c.localBootstrap.signedEnrollmentStoredInProtectedBroker=false;
  const third=request('fd126d10-d1ab-4fa9-baad-fd1925001027');
  const invalid=gate(third,c);
  assert.equal(invalid.reason,'LOCAL_ONE_TIME_UAC_BOOTSTRAP_UNVERIFIED');
  assert.equal(invalid.requiresPerCommandUac,false);
  assert.equal(journal.reserve(third,c),false);
  assert.equal(journal.launchEvents.length,2);
});

test('revoked owner plus lost ACK: source denial is not physical no-effect attestation',()=>{
  const journal=new SimulatedWitness(),r=request(),c=context();
  assert.equal(journal.reserve(r,c),true);
  assert.equal(journal.launch(r,c),true);
  c.pendingMutationUnknown=true;
  c.ownerRevoked=true;
  // Real source prioritizes revoke; record this limitation, not false proof.
  const source=gate(r,c);
  assert.equal(source.reason,'GRANT_REVOKED');
  assert.equal(source.privilegedExecutionOccurred,false);
  assert.equal(source.verifiedEffect,false);
  assert.equal(source.automaticallyRetryable,false);
  assert.equal(journal.lostAck(r.requestId),'MUTATION_UNKNOWN');
  assert.equal(journal.cancel(r.requestId),'MUTATION_UNKNOWN');
});
