import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {bindHelperRollbackGuard} from '../../src/security/protected-helper-rollback-guard.js';
import {startProtectedTransferAndCoreServices} from '../../src/security/protected-transfer-services-startup.js';
import type {HelperAuthorityEvidenceRequest} from '../../src/security/postgres-helper-selection-authority.js';
import type {HelperEvidenceChallenge} from '../../src/security/signed-helper-selection-evidence.js';
import {runSelectionBoundHelperDeployment} from '../../src/installer/protected-helper-entrypoints.js';
import type {HelperSelectionTlsConfig} from '../../src/security/protected-helper-selection-transport.js';
const key=generateKeyPairSync('ed25519'),other=generateKeyPairSync('ed25519');
const pem=(k:typeof key)=>k.publicKey.export({type:'spki',format:'pem'}).toString();
const a={sha256:'a'.repeat(64),signerSha256:'b'.repeat(64)},b={sha256:'c'.repeat(64),signerSha256:'d'.repeat(64)};
const scope={authorityId:randomUUID(),deviceId:randomUUID(),ownerId:randomUUID(),deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),ownerEpoch:1,generation:1,brokerId:randomUUID()};
const selection={revision:randomUUID(),pin:a};
const request={requestId:randomUUID(),operation:'rollback' as const,expected:selection,desired:b};
const observation:HelperAuthorityEvidenceRequest={phase:'COMMIT',scope,lease:{id:randomUUID(),requestId:request.requestId,kind:'DEPLOYMENT',expectedRevision:selection.revision},selection,request};
const challenge:HelperEvidenceChallenge={domain:'nexowire.helper-selection-native-evidence.v1',nonce:'1'.repeat(64),requestSha256:'2'.repeat(64),phase:'COMMIT'};
const native={observerPublicKeyPem:pem(key),async requestProof(){return 'native proof';}};
const reviewed={manifestSha256:'5'.repeat(64),sourceCommit:'6'.repeat(40),releaseSequence:2,reader:'sqlite-only' as const,schemaVersion:1 as const};
const approved={runtime:reviewed,helperPin:b,approvedStateSha256:'3'.repeat(64),sqliteTreeSha256:'7'.repeat(64),sqliteRecords:1};
const sqliteReview={manifestSha256:reviewed.manifestSha256,sourceCommit:reviewed.sourceCommit,releaseSequence:2,schemaVersion:1,treeSha256:approved.sqliteTreeSha256,sqliteRecords:1,succeeded:1,failed:0,unknown:0,inProgress:0,releaseAnchorAdvanced:false,productionRollbackAuthorized:false};
function proof(c:HelperEvidenceChallenge,changes:Record<string,unknown>={},signer=other.privateKey){
  const observedAt=Date.now(),payload=JSON.stringify({domain:'nexowire.helper-rollback-guard.v2',nonce:c.nonce,requestSha256:c.requestSha256,phase:c.phase,
    approvedStateSha256:'3'.repeat(64),currentStateSha256:'3'.repeat(64),writerFenced:true,unknownOperations:false,recoveryPending:false,priorHelperCompatible:true,sqliteReview,observedAt,expiresAt:observedAt+2000,...changes});
  return {payload,proof:sign(null,Buffer.from(payload),signer).toString('base64url')};
}
test('rollback guard requires separate signed equal-state proof at commit',async()=>{
  const guarded=bindHelperRollbackGuard(native,{observerPublicKeyPem:pem(other),approved,async requestProof(c){return proof(c);}});
  assert.equal(await guarded.requestProof(challenge,observation),'native proof');
  for(const changes of [{currentStateSha256:'4'.repeat(64)},{unknownOperations:true},{recoveryPending:true},{writerFenced:false},{priorHelperCompatible:false},{sqliteReview:{...sqliteReview,releaseSequence:1}},{sqliteReview:{...sqliteReview,treeSha256:'8'.repeat(64)}},{sqliteReview:{...sqliteReview,productionRollbackAuthorized:true}},{sqliteReview:{...sqliteReview,unknown:1}},{sqliteReview:{...sqliteReview,inProgress:1}},{sqliteReview:{...sqliteReview,succeeded:0}},{domain:'nexowire.helper-rollback-guard.v1'},{nonce:'0'.repeat(64)},{requestSha256:'0'.repeat(64)},{phase:'READ'},{expiresAt:Date.now()-1000}]){
    const denied=bindHelperRollbackGuard(native,{observerPublicKeyPem:pem(other),approved,async requestProof(c){return proof(c,changes);}});
    await assert.rejects(denied.requestProof(challenge,observation),/GUARD_DENIED/);
  }
  const wrong=bindHelperRollbackGuard(native,{observerPublicKeyPem:pem(other),approved,async requestProof(c){return proof(c,{},key.privateKey);}});
  await assert.rejects(wrong.requestProof(challenge,observation),/GUARD_DENIED/);
  assert.throws(()=>bindHelperRollbackGuard(native,{observerPublicKeyPem:pem(key),approved,async requestProof(){return null;}}),/GUARD_CONFIG_INVALID/);
});
test('guard applies at admission and commit, not ordinary upgrade',async()=>{
  const calls:string[]=[];
  const guarded=bindHelperRollbackGuard(native,{observerPublicKeyPem:pem(other),approved,async requestProof(c){calls.push(c.phase);return proof(c);}});
  for(const phase of ['BEGIN_DEPLOYMENT','COMMIT'] as const)
    assert.equal(await guarded.requestProof({...challenge,phase},{...observation,phase}),'native proof');
  await guarded.requestProof(challenge,{...observation,request:{...request,operation:'upgrade',sourcePath:'offline'}});
  assert.deepEqual(calls,['BEGIN_DEPLOYMENT','COMMIT']);
});
test('deployment rejects wrong role or scoped identity before transport',async()=>{
  const tls={role:'deployment',scope} as HelperSelectionTlsConfig;
  const config={selection:tls,deviceId:scope.deviceId,ownerId:scope.ownerId,authorityId:scope.authorityId,async assertInstalledRuntime(){throw Error('unexpected');}};
  for(const bad of [{...config,selection:{...tls,role:'runtime' as const}},{...config,deviceId:randomUUID()},{...config,ownerId:randomUUID()},{...config,authorityId:randomUUID()}])
    await assert.rejects(runSelectionBoundHelperDeployment(bad,request),/DEPLOYMENT_SCOPE_MISMATCH/);
});

test('canonical three-listener startup refuses missing or self-issued rollback guard before opening any service',async()=>{
  const database={host:'127.0.0.1',port:5432,database:'must-not-connect',caPem:'fixture'};
  const config={
    core:{authorityId:scope.authorityId,database,port:8441,async verifyNativeDrain(){throw Error('unexpected drain');}},
    transfer:{database,authority:{authorityId:scope.authorityId},server:{authorityId:scope.authorityId,async verifyIndependentProvenance(){throw Error('unexpected provenance');}}},
    selection:{database,authority:{scope,async verifyProvenance(){throw Error('unexpected provenance');}},nativeEvidence:native},
    startupScope:{ownerId:scope.ownerId,targetDeviceId:scope.deviceId},
    transferHost:'127.0.0.1',transferPort:8442,selectionHost:'127.0.0.1',selectionPort:8443,
    async verifyTransferRuntimeDrain(){throw Error('unexpected drain');},
  };
  type Config=Parameters<typeof startProtectedTransferAndCoreServices>[0];
  await assert.rejects(startProtectedTransferAndCoreServices(config as unknown as Config),/TRANSFER_CORE_SHARED_AUTHORITY_STARTUP_REQUIRED/);
  const selfIssued={observerPublicKeyPem:pem(key),approved,async requestProof(){throw Error('unexpected proof');}};
  await assert.rejects(startProtectedTransferAndCoreServices({...config,rollbackGuard:selfIssued} as unknown as Config),/HELPER_ROLLBACK_GUARD_CONFIG_INVALID/);
});
