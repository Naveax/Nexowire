import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  canonicalCompletionStatement, canonicalImmutableSeal,
  canonicalFinalPublicationWitness, verifyOffhostCompletion,
  type CompletionStatement, type TrustedCompletionPorts, type OwnerGrantView,
} from '../src/agent/trusted-worker-completion.js';
import { ProgressSupervisor } from '../src/agent/progress-supervisor.js';
import { verifyResultFiles } from '../src/agent/progress-proof-verifier.js';

const sha=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
const scope={
  ownerAccountId:'owner-fixture',deviceId:'device-fixture',projectId:'project-fixture',
  runId:'run-fixture',sessionId:'550e8400-e29b-41d4-a716-446655440000',
};
const requestId='550e8400-e29b-41d4-a716-446655440001';
const jobId='550e8400-e29b-41d4-a716-446655440002';
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const {privateKey:storagePrivateKey,publicKey:storagePublicKey}=generateKeyPairSync('ed25519');
const {privateKey:publishPrivateKey,publicKey:publishPublicKey}=generateKeyPairSync('ed25519');
function makeEvidence(now=Date.now()) {
  const s:CompletionStatement={
    version:1,...scope,requestId,grantId:'grant-core-fixture',
    ownerGrantEpoch:21,role:'CORE',jobId,sourceDeviceId:scope.deviceId,
    targetDeviceId:'offhost-receipt-device',targetPath:'/receipts/final.json',
    resultSetSha256:'a'.repeat(64),immutableObjectSha256:'0'.repeat(64),
    outputProofSha256:'b'.repeat(64),completedCount:2,pendingCount:0,
    failureCount:0,exitCode:0,exitObservedAt:new Date(now).toISOString(),
    committedAt:new Date(now).toISOString(),
  };
  return s;
}
function signedFixture(statement:CompletionStatement) {
  const {immutableObjectSha256:_digest,...contents}=statement;
  const body=Buffer.from(JSON.stringify(contents));
  const s={...statement,immutableObjectSha256:sha(body)};
  const signatureBase64=sign(null,canonicalCompletionStatement(s),privateKey).toString('base64');
  return {receipt:{statement:s,signatureBase64},body};
}
function mockPorts(
  statement:CompletionStatement,body:Buffer,
  overrides:{grant?:Partial<OwnerGrantView>;transferState?:string;corrupt?:boolean;
    cancelOnRead?:boolean;partialRead?:boolean;
    transferChangesOnSecondRead?:boolean;epochChangesOnSecondRead?:boolean;
    forgedImmutableSeal?:boolean;missingFinal?:boolean;
    forgedFinal?:boolean;foreignFinal?:boolean;badWriterEpoch?:boolean}={},
):TrustedCompletionPorts {
  let grantRead=0;
  let transferRead=0;
  const sealContents={
    version:1 as const,ownerAccountId:statement.ownerAccountId,
    projectId:statement.projectId,targetDeviceId:statement.targetDeviceId,
    targetPath:statement.targetPath,jobId:statement.jobId,
    ownerGrantEpoch:statement.ownerGrantEpoch,
    immutableObjectSha256:statement.immutableObjectSha256,
    sealedAt:statement.committedAt,
  };
  const sealSignature=sign(null,canonicalImmutableSeal(sealContents),storagePrivateKey).toString('base64');
  const publicationContents={version:1 as const,
    publicationRequestId:'550e8400-e29b-41d4-a716-446655440004',
    jobId:statement.jobId,ownerAccountId:statement.ownerAccountId,
    projectId:statement.projectId,targetDeviceId:statement.targetDeviceId,
    targetPath:statement.targetPath,bytesTotal:body.length,
    sha256:statement.immutableObjectSha256,writerEpoch:2,
    publishedAt:statement.committedAt,
  };
  const publicationSignature=sign(null,
    canonicalFinalPublicationWitness(publicationContents),publishPrivateKey).toString('base64');
  const getGrant=():OwnerGrantView=>{
    grantRead++;
    return {
      ownerAccountId:statement.ownerAccountId,projectId:statement.projectId,
      deviceId:statement.deviceId,grantId:statement.grantId,
      epoch:overrides.epochChangesOnSecondRead&&grantRead>=2 ?
        statement.ownerGrantEpoch+1 : statement.ownerGrantEpoch,role:'CORE',
      state:overrides.cancelOnRead&&grantRead>=2?'CANCELED':'ACTIVE',
      ...overrides.grant,
    };
  };
  return {
    readFinalPublicationWitness:async()=>{
      if(overrides.missingFinal)throw Error('FINAL_NATIVE_RECEIPT_UNAVAILABLE');
      return {...publicationContents,
        ...(overrides.foreignFinal?{jobId:'550e8400-e29b-41d4-a716-446655440099'}:{}),
        ...(overrides.badWriterEpoch?{writerEpoch:0}:{}),
        signatureBase64:overrides.forgedFinal?Buffer.alloc(64).toString('base64'):
          publicationSignature};
    },
    readImmutableSeal:async()=>({...sealContents,signatureBase64:
      overrides.forgedImmutableSeal?Buffer.alloc(64).toString('base64'):sealSignature}),
    readGrant:async()=>getGrant(),
    readTransfer:async()=>({
      id:statement.jobId,state:overrides.transferChangesOnSecondRead&&++transferRead>=2 ?
        'MUTATION_UNKNOWN' : overrides.transferState??'COMPLETED',
      sourceDeviceId:statement.sourceDeviceId,targetDeviceId:statement.targetDeviceId,
      targetPath:statement.targetPath,sha256:statement.immutableObjectSha256,
      bytesTotal:body.length,bytesConfirmed:body.length,
    }),
    readOffhost:async(offset,maxBytes)=>{
      const bytes=Buffer.from(body);
      if(overrides.corrupt)bytes[bytes.length-1]=(bytes[bytes.length-1]??0)^1;
      const next=bytes.subarray(offset,offset+Math.min(maxBytes,
        overrides.partialRead?Math.max(1,maxBytes-1):maxBytes));
      return {offset,totalBytes:bytes.length,contentBase64:next.toString('base64')};
    },
  };
}
const expected=(s:CompletionStatement)=>({
  ...scope,requestId,grantId:s.grantId,ownerGrantEpoch:s.ownerGrantEpoch,
  publicationRequestId:'550e8400-e29b-41d4-a716-446655440004',writerEpoch:2,
  sourceDeviceId:s.sourceDeviceId,targetDeviceId:s.targetDeviceId,
  targetPath:s.targetPath,resultSetSha256:s.resultSetSha256,
  outputProofSha256:s.outputProofSha256,completedCount:s.completedCount,
  exitObservedAt:s.exitObservedAt,
});

test('signed Ed25519 + independent CORE epoch and off-host rehashed object issue a bounded permit',async()=>{
  const base=makeEvidence();
  const {receipt,body}=signedFixture(base);
  const proof=await verifyOffhostCompletion(receipt,expected(receipt.statement),
    publicKey,storagePublicKey,publishPublicKey,mockPorts(receipt.statement,body));
  assert.ok(proof);
  assert.equal(proof.statement.ownerGrantEpoch,21);
  assert.equal(proof.statement.immutableObjectSha256,sha(body));
});
test('fake signature, object hash, owner grant epoch, revoked CORE, and cancellation race reject',async()=>{
  const {receipt,body}=signedFixture(makeEvidence());
  const e=expected(receipt.statement);
  assert.equal(await verifyOffhostCompletion({...receipt,signatureBase64:Buffer.alloc(64,0).toString('base64')},
    e,publicKey,storagePublicKey,publishPublicKey,mockPorts(receipt.statement,body)),null);
  for(const overrides of [
    {grant:{epoch:22}}, {grant:{state:'REVOKED'}},
    {grant:{role:'ROOT'}},{cancelOnRead:true},
    {transferState:'MUTATION_UNKNOWN'},{transferState:'CANCEL_REQUESTED'},
    {transferChangesOnSecondRead:true},{epochChangesOnSecondRead:true},
    {forgedImmutableSeal:true},{missingFinal:true},
    {forgedFinal:true},{foreignFinal:true},{badWriterEpoch:true},{corrupt:true},
  ] as Parameters<typeof mockPorts>[2][]){
    assert.equal(await verifyOffhostCompletion(receipt,e,publicKey,storagePublicKey,publishPublicKey,
      mockPorts(receipt.statement,body,overrides)),null,
      'untrusted grant/mutation/cancel/disk content must fail closed');
  }
  assert.equal(await verifyOffhostCompletion(receipt,e,publicKey,publicKey,publishPublicKey,
    mockPorts(receipt.statement,body)),null,
    'same signer cannot authorize both worker result and immutable storage');
  assert.equal(await verifyOffhostCompletion(receipt,{...e,ownerGrantEpoch:22},
    publicKey,storagePublicKey,publishPublicKey,mockPorts(receipt.statement,body)),null);
});
test('replayed ancient receipt, foreign offhost target, and dropped chunk fail closed',async()=>{
  const old=makeEvidence(Date.now()-60000);
  const {receipt:ancient,body}=signedFixture(old);
  assert.equal(await verifyOffhostCompletion(ancient,expected(ancient.statement),
    publicKey,storagePublicKey,publishPublicKey,mockPorts(ancient.statement,body)),null);
  const {receipt,body:current}=signedFixture(makeEvidence());
  assert.equal(await verifyOffhostCompletion(receipt,
    {...expected(receipt.statement),targetDeviceId:'wrong'},
    publicKey,storagePublicKey,publishPublicKey,mockPorts(receipt.statement,current)),null);
  const truncated:TrustedCompletionPorts={
    ...mockPorts(receipt.statement,current),
    readOffhost:async(offset,maxBytes)=>{
      const b=current.subarray(offset,offset+Math.min(maxBytes,1));
      return {offset:offset+1,totalBytes:current.length,contentBase64:b.toString('base64')};
    },
  };
  assert.equal(await verifyOffhostCompletion(receipt,expected(receipt.statement),
    publicKey,storagePublicKey,publishPublicKey,truncated),null);
});
test('only authenticated permit enables completed_verified; raw RPC receipts fail; CORE revoke erases result',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-trusted-complete-'));
  const clock={now:Date.now()};
  const p=new ProgressSupervisor({now:()=>clock.now});
  p.register(scope.sessionId);
  p.bindTrustedRequest(scope.sessionId,requestId);
  try{
    const fixture=path.resolve('test/fixtures/progress-result-worker-fixture.cjs');
    const output=execFileSync(process.execPath,[fixture,root,'complete',scope.runId,
      scope.sessionId],{encoding:'utf8',timeout:5000,windowsHide:true,maxBuffer:16384});
    p.observeProcessEvent({topic:'process.output',data:{sessionId:scope.sessionId,
      stream:'stdout',text:output}});
    p.observeProcessEvent({topic:'process.exited',data:{sessionId:scope.sessionId,
      exitCode:0,exitedAt:new Date(clock.now).toISOString()}});
    const request={runRoot:root,scope:{...scope},expectedCount:2};
    const disk=await verifyResultFiles(request,()=>clock.now);
    assert.equal(disk.status,'verified');
    const base={...makeEvidence(clock.now),resultSetSha256:disk.artifactSha256!,
      outputProofSha256:sha(output)};
    const {receipt,body}=signedFixture(base);
    const raw=await p.verifySessionFromDisk(scope.sessionId,request,{
      authority:'trusted_storage_adapter',requestId,sessionId:scope.sessionId,
      immutableArtifactSha256:disk.artifactSha256!,outputProofSha256:sha(output),
      committedAt:new Date(clock.now).toISOString(),exitCode:0,
      exitObservedAt:new Date(clock.now).toISOString(),
    });
    assert.equal(raw.status,'unverified');
    assert.notEqual(p.snapshot(scope.sessionId).state,'completed_verified');
    const permit=await verifyOffhostCompletion(receipt,expected(receipt.statement),
      publicKey,storagePublicKey,publishPublicKey,mockPorts(receipt.statement,body),()=>clock.now);
    assert.ok(permit);
    const accepted=await p.verifySessionFromDisk(scope.sessionId,request,permit);
    assert.equal(accepted.status,'verified');
    assert.equal(p.snapshot(scope.sessionId).state,'completed_verified');
    assert.equal(p.snapshot(scope.sessionId).verifiedOwnerGrantEpoch,21);
    p.invalidateOwnerGrant(scope.sessionId);
    assert.equal(p.snapshot(scope.sessionId).completionAttested,false);
    assert.notEqual(p.snapshot(scope.sessionId).state,'completed_verified');
    assert.equal(p.snapshot(scope.sessionId).restartAllowed,false);
    // Even a previously cryptographically accepted permit cannot resurrect
    // a canceled CORE owner grant on the same session.
    assert.equal((await p.verifySessionFromDisk(scope.sessionId,request,permit)).reason,
      'OWNER_GRANT_REVOKED');
    assert.notEqual(p.snapshot(scope.sessionId).state,'completed_verified');
    assert.equal(p.bindTrustedRequest(scope.sessionId,requestId),false);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
