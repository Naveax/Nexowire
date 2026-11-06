import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProgressSupervisor } from '../src/agent/progress-supervisor.js';
import { verifyResultFiles } from '../src/agent/progress-proof-verifier.js';
import {
  canonicalCompletionStatement,canonicalImmutableSeal,
  canonicalFinalPublicationWitness,canonicalMonotonicPublicationCommit,
  type OwnerGrantView,type CompletionStatement,
  type SignedCompletion,type TransferView,
} from '../src/agent/trusted-worker-completion.js';
import {
  ProgressRuntimePostconditionAdapter,canonicalPostconditionWitness,
  type PostconditionWitness, type RuntimeCompletionPorts,
} from '../src/agent/progress-runtime-postcondition.js';

const sha=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
const ownerAccountId='owner-fixture', deviceId='device-fixture',
  projectId='project-fixture',runId='run-fixture',
  sessionId='550e8400-e29b-41d4-a716-446655440000',
  requestId='550e8400-e29b-41d4-a716-446655440001',
  jobId='550e8400-e29b-41d4-a716-446655440002';
const scope={ownerAccountId,deviceId,projectId,runId,sessionId};
const issuer=generateKeyPairSync('ed25519');
const storage=generateKeyPairSync('ed25519');
const publication=generateKeyPairSync('ed25519');
const monotonicCommit=generateKeyPairSync('ed25519');
const witness=generateKeyPairSync('ed25519');

type Fixtures=Awaited<ReturnType<typeof setup>>;
async function setup() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'progress-postcondition-'));
  let now=Date.now();
  const p=new ProgressSupervisor({now:()=>now,stallAfterMs:1000});
  p.register(sessionId);
  assert.equal(p.bindTrustedRequest(sessionId,requestId),true);
  const fixture=path.resolve('test/fixtures/progress-result-worker-fixture.cjs');
  const output=execFileSync(process.execPath,[fixture,root,'complete',runId,sessionId],
    {encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:16384});
  p.observeProcessEvent({topic:'process.output',data:{
    sessionId,stream:'stdout',text:output,
  }});
  p.observeProcessEvent({topic:'process.exited',data:{
    sessionId,exitCode:0,exitedAt:new Date(now).toISOString(),
  }});
  const proofRequest={runRoot:root,scope:{...scope},expectedCount:2};
  const disk=await verifyResultFiles(proofRequest,()=>now);
  assert.equal(disk.status,'verified');
  const base:CompletionStatement={
    version:1,...scope,requestId,grantId:'grant-core-fixture',
    ownerGrantEpoch:9,role:'CORE',jobId,
    sourceDeviceId:deviceId,targetDeviceId:'trusted-offhost',targetPath:'/immutable/result.json',
    resultSetSha256:disk.artifactSha256!,immutableObjectSha256:'0'.repeat(64),
    outputProofSha256:sha(output),completedCount:2,pendingCount:0,failureCount:0,
    exitCode:0,exitObservedAt:new Date(now).toISOString(),
    committedAt:new Date(now).toISOString(),
  };
  const {immutableObjectSha256:_digest,...raw}=base;
  const offhost=Buffer.from(JSON.stringify(raw));
  const s={...base,immutableObjectSha256:sha(offhost)};
  const signed:SignedCompletion={
    statement:s,
    signatureBase64:sign(null,canonicalCompletionStatement(s),issuer.privateKey).toString('base64'),
  };
  const sealPayload={
    version:1 as const,ownerAccountId,projectId,targetDeviceId:s.targetDeviceId,
    targetPath:s.targetPath,jobId,ownerGrantEpoch:9,
    immutableObjectSha256:s.immutableObjectSha256,sealedAt:s.committedAt,
  };
  const publishedPayload={version:1 as const,
    publicationRequestId:'550e8400-e29b-41d4-a716-446655440004',
    jobId,ownerAccountId,projectId,targetDeviceId:s.targetDeviceId,
    targetPath:s.targetPath,bytesTotal:offhost.length,sha256:s.immutableObjectSha256,
    writerEpoch:7,publishedAt:new Date(now).toISOString(),
  };
  const publishedSignature=sign(null,canonicalFinalPublicationWitness(publishedPayload),
    publication.privateKey).toString('base64');
  const commitContents={version:1 as const,
    durableCommitId:'550e8400-e29b-41d4-a716-446655440005',
    publicationRequestId:publishedPayload.publicationRequestId,
    jobId,ownerAccountId,projectId,targetDeviceId:s.targetDeviceId,
    targetPath:s.targetPath,sha256:s.immutableObjectSha256,
    bytesTotal:offhost.length,writerEpoch:7,ownerGrantEpoch:9,
    committedAt:new Date(now).toISOString(),
  };
  const witnessPayload={
    version:1 as const,requestId,jobId,ownerAccountId,projectId,
    targetDeviceId:s.targetDeviceId,targetPath:s.targetPath,
    ownerGrantEpoch:9,sha256:s.immutableObjectSha256,
    bytesConfirmed:offhost.length,observedAt:new Date(now).toISOString(),
  };
  const trustedPostcondition:PostconditionWitness={
    ...witnessPayload,
    signatureBase64:sign(null,canonicalPostconditionWitness(witnessPayload),
      witness.privateKey).toString('base64'),
  };
  const mutable={
    grantState:'ACTIVE' as OwnerGrantView['state'],
    epoch:9,grantReads:0,cancelAfterGrantReads:0,
    transferState:'COMPLETED',transferReads:0,
    transferChangeAt:0,raiseTransport:false,raiseAfterReads:0,
    tamperOffhost:false,truncated:false,missingRead:false,
    missingNativePublication:false,forgedNativePublication:false,
    foreignNativePublication:false,latePublicationLoss:false,
    noMonotonicCommit:false,staleCommitOwnerEpoch:false,
    witness:trustedPostcondition,
  };
  const ports:RuntimeCompletionPorts={
    readGrant:async()=>{
      mutable.grantReads++;
      return {
        ownerAccountId,deviceId,projectId,grantId:s.grantId,epoch:mutable.epoch,
        role:'CORE',state:mutable.cancelAfterGrantReads>0&&
          mutable.grantReads>=mutable.cancelAfterGrantReads ?
          'CANCEL_REQUESTED':mutable.grantState,
      };
    },
    readTransfer:async()=>{
      mutable.transferReads++;
      if(mutable.raiseTransport && (!mutable.raiseAfterReads ||
          mutable.transferReads>=mutable.raiseAfterReads))throw Error('LOST_ACK');
      return {
        id:jobId,state:mutable.transferChangeAt>0&&
          mutable.transferReads>=mutable.transferChangeAt?
          'MUTATION_UNKNOWN':mutable.transferState,
        sourceDeviceId:deviceId,targetDeviceId:s.targetDeviceId,
        targetPath:s.targetPath,bytesTotal:offhost.length,
        bytesConfirmed:offhost.length,sha256:s.immutableObjectSha256,
      };
    },
    readOffhost:async(offset,maxBytes)=>{
      const content=Buffer.from(offhost);
      if(mutable.tamperOffhost)content[0]=0x40;
      const read=mutable.missingRead?Buffer.alloc(0):
        content.subarray(offset,offset+Math.min(maxBytes,
          mutable.truncated?1:maxBytes));
      return {offset,totalBytes:content.length,contentBase64:read.toString('base64')};
    },
    readMonotonicPublicationCommit:async()=>{
      if(mutable.noMonotonicCommit)throw Error('EXTERNAL_COMMIT_UNAVAILABLE');
      const body={...commitContents,
        ...(mutable.staleCommitOwnerEpoch?{ownerGrantEpoch:8}:{})};
      return {...body,signatureBase64:sign(null,
        canonicalMonotonicPublicationCommit(body),monotonicCommit.privateKey)
        .toString('base64')};
    },
    readFinalPublicationWitness:async()=>{
      if(mutable.missingNativePublication || mutable.latePublicationLoss)
        throw Error('INDEPENDENT_NATIVE_PUBLICATION_UNAVAILABLE');
      return {...publishedPayload,
        ...(mutable.foreignNativePublication?{publicationRequestId:requestId}:{}),
        signatureBase64:mutable.forgedNativePublication?
          Buffer.alloc(64).toString('base64'):publishedSignature};
    },
    readImmutableSeal:async()=>({
      ...sealPayload,
      signatureBase64:sign(null,canonicalImmutableSeal(sealPayload),
        storage.privateKey).toString('base64'),
    }),
    readPostcondition:async()=>mutable.witness,
  };
  const expected={
    ...scope,requestId,grantId:s.grantId,ownerGrantEpoch:9,
    publicationRequestId:publishedPayload.publicationRequestId,writerEpoch:7,
    sourceDeviceId:deviceId,targetDeviceId:s.targetDeviceId,targetPath:s.targetPath,
    resultSetSha256:s.resultSetSha256,outputProofSha256:s.outputProofSha256,
    completedCount:2,exitObservedAt:s.exitObservedAt,
  };
  const adapter=new ProgressRuntimePostconditionAdapter(p,proofRequest,expected,{
    issuer:issuer.publicKey,immutableStorage:storage.publicKey,
    publication:publication.publicKey,
    monotonicCommit:monotonicCommit.publicKey,postcondition:witness.publicKey,
  },ports,()=>now);
  return {adapter,p,ports,signed,mutable,expected,offhost,request:proofRequest,
    setNow:(next:number)=>{now=next;},now:()=>now,
    cleanup:()=>fs.rm(root,{recursive:true,force:true})};
}
async function scenario(run:(f:Fixtures)=>Promise<void>) {
  const f=await setup();
  try{await run(f)}finally{await f.cleanup();}
}
test('independent signed SHA-256 postcondition + fresh CORE epoch => completed_verified',()=>scenario(async f=>{
  assert.equal(await f.adapter.reconcile(f.signed),'COMPLETED_VERIFIED');
  assert.equal(f.p.snapshot(sessionId).state,'completed_verified');
  assert.equal(f.p.snapshot(sessionId).verifiedOwnerGrantEpoch,9);
  assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
  assert.match(f.adapter.snapshot().postconditionSha256!,/^[a-f0-9]{64}$/);
}));
test('forged COMPLETED RPC cannot substitute absent or mismatched signed postcondition',()=>scenario(async f=>{
  f.mutable.witness={...f.mutable.witness,sha256:'f'.repeat(64)};
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
  assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
}));
test('forged postcondition signature and unrelated postcondition key reject',()=>scenario(async f=>{
  f.mutable.witness={...f.mutable.witness,
    signatureBase64:Buffer.alloc(64).toString('base64')};
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
}));
test('CORE epoch rotated before use or CANCEL_REQUESTED must fail closed',async()=>{
  await scenario(async f=>{
    f.mutable.epoch=10;
    assert.equal(await f.adapter.reconcile(f.signed),'CANCELLED_OR_STALE_CORE');
    assert.equal(f.p.snapshot(sessionId).completionAttested,false);
    assert.equal(await f.adapter.reconcile(f.signed),'CANCELLED_OR_STALE_CORE');
  });
  await scenario(async f=>{
    f.mutable.grantState='CANCEL_REQUESTED';
    assert.equal(await f.adapter.reconcile(f.signed),'CANCELLED_OR_STALE_CORE');
    assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
  });
});
test('CORE cancel after readback but before acceptance revokes the staged proof',()=>scenario(async f=>{
  f.mutable.cancelAfterGrantReads=3;
  assert.equal(await f.adapter.reconcile(f.signed),'CANCELLED_OR_STALE_CORE');
  assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
  assert.equal(f.p.snapshot(sessionId).completionAttested,false);
}));
test('lost status ACK is sticky UNKNOWN and cannot auto-replay later fake COMPLETED',()=>scenario(async f=>{
  f.mutable.raiseTransport=true;
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  f.mutable.raiseTransport=false;
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
  assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
}));
test('transfer switches to MUTATION_UNKNOWN during offhost read and is not completed',()=>scenario(async f=>{
  f.mutable.transferChangeAt=3;
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
  assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
}));
test('reported COMPLETED but partial or altered offhost content cannot pass SHA postcondition',async()=>{
  await scenario(async f=>{
    f.mutable.tamperOffhost=true;
    assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
    assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
  });
  await scenario(async f=>{
    f.mutable.missingRead=true;
    assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
    assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
  });
  await scenario(async f=>{
    f.mutable.truncated=true;
    assert.equal(await f.adapter.reconcile(f.signed),'COMPLETED_VERIFIED');
    // Fragmented but complete offset-correct readback is valid; the caller
    // must not equate small chunks with corrupted/missing chunks.
    assert.equal(f.p.snapshot(sessionId).state,'completed_verified');
  });
});
test('RUNNING, PUBLISHING and CANCEL_REQUESTED cannot produce completion',async()=>{
  for(const state of ['RUNNING','PUBLISHING'])await scenario(async f=>{
    f.mutable.transferState=state;
    assert.equal(await f.adapter.reconcile(f.signed),'REPORTED_ONLY');
    assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
  });
  await scenario(async f=>{
    f.mutable.transferState='CANCEL_REQUESTED';
    assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  });
});
test('worker lost before verification prevents a valid signed receipt from completing',()=>scenario(async f=>{
  f.p.recover([{sessionId,status:'lost',exitCode:null}]);
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.equal(f.p.snapshot(sessionId).state,'lost');
}));

test('native-write cancellation pending during signed readback cannot become completed_verified',()=>scenario(async f=>{
  f.mutable.transferChangeAt=2;
  f.mutable.transferState='CANCEL_REQUESTED';
  // Transfer was initially COMPLETED; a native-write cancellation witness
  // becomes visible at the next authenticated transfer read.
  const original=f.ports.readTransfer;
  let reads=0;
  f.ports.readTransfer=async()=>{
    reads++;
    const item=await original();
    return reads>=2?{...item,state:'CANCEL_REQUESTED'}:item;
  };
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.equal(f.p.snapshot(sessionId).completionAttested,false);
  assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
  assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
}));

test('native-write CORE cancel arriving after disk proof revokes cached completion',()=>scenario(async f=>{
  // readGrant calls: runtime initial (1), immutable verifier start/end (2-3),
  // runtime pre-local disk (4), then after local disk (5).
  f.mutable.cancelAfterGrantReads=5;
  assert.equal(await f.adapter.reconcile(f.signed),'CANCELLED_OR_STALE_CORE');
  assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
  assert.equal(f.p.snapshot(sessionId).completionAttested,false);
  assert.equal(await f.adapter.reconcile(f.signed),'CANCELLED_OR_STALE_CORE');
}));

test('counterfeit COMPLETED with wrong digest or short confirmed bytes is sticky UNKNOWN',async()=>{
  for(const variant of ['digest','short','failed','recovery'] as const){
    await scenario(async f=>{
      const original=f.ports.readTransfer;
      f.ports.readTransfer=async()=>{
        const current=await original();
        if(variant==='digest')return {...current,sha256:'0'.repeat(64)};
        if(variant==='short')return {...current,bytesConfirmed:current.bytesTotal-1};
        if(variant==='failed')return {...current,state:'FAILED'};
        return {...current,state:'RECOVERY_REQUIRED'};
      };
      assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
      f.ports.readTransfer=original;
      assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
      assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
      assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
    });
  }
});

test('lost PID during postcondition off-host SHA readback invalidates the result',()=>scenario(async f=>{
  const original=f.ports.readOffhost;
  let lost=false;
  f.ports.readOffhost=async(offset,size)=>{
    const value=await original(offset,size);
    if(!lost){
      lost=true;
      f.p.recover([{sessionId,status:'lost',exitCode:null}]);
    }
    return value;
  };
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.equal(f.p.snapshot(sessionId).state,'lost');
  assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
}));

test('stalled synthetic worker with 100% self-report but no OS exit cannot complete',()=>scenario(async f=>{
  f.p.recover([{sessionId,status:'running',exitCode:null}]);
  f.setNow(f.now()+1500);
  const snapshot=f.p.snapshot(sessionId);
  assert.equal(snapshot.state,'stalled');
  assert.equal(snapshot.processState,'running');
  assert.notEqual(snapshot.state,'completed_verified');
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
}));

test('lost ACK during asynchronous immutable readback stays sticky UNKNOWN',()=>scenario(async f=>{
  const original=f.ports.readOffhost;
  let ackLost=false;
  f.ports.readOffhost=async(offset,maxBytes)=>{
    const value=await original(offset,maxBytes);
    if(!ackLost){
      ackLost=true;
      assert.equal(f.adapter.observeLostAck(),'MUTATION_UNKNOWN');
    }
    return value;
  };
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
  assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
}));

test('counterfeit COMPLETED after lost ACK cannot poll, replay, or recertify a result',()=>scenario(async f=>{
  // No network or disk calls should be reached after the first lost ACK.
  const first=f.adapter.observeLostAck();
  assert.equal(first,'MUTATION_UNKNOWN');
  f.ports.readTransfer=async()=>{throw Error('REPLAYED_STATUS_POLL');};
  const counterfeit={...f.signed,signatureBase64:Buffer.alloc(64,0).toString('base64')};
  assert.equal(await f.adapter.reconcile(counterfeit),'MUTATION_UNKNOWN');
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.equal(f.adapter.snapshot().postconditionSha256,null);
  assert.equal(f.p.snapshot(sessionId).completionAttested,false);
  assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
}));

test('forged COMPLETED following lost PID or stalled worker is sticky UNKNOWN',async()=>{
  await scenario(async f=>{
    f.p.recover([{sessionId,status:'lost',exitCode:null}]);
    assert.equal(f.adapter.observeLostPid(),'MUTATION_UNKNOWN');
    // A stale worker may reconnect and claim a completed result. The prior
    // unknown process identity cannot be safely converted into completion.
    f.p.recover([{sessionId,status:'exited',exitCode:0}]);
    assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
    assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
    assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
  });
  await scenario(async f=>{
    f.p.recover([{sessionId,status:'running',exitCode:null}]);
    f.setNow(f.now()+1500);
    assert.equal(f.p.snapshot(sessionId).state,'stalled');
    assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
    assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
    assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
  });
});

test('pending native write cancel injected during readback makes later completed receipt UNKNOWN',()=>scenario(async f=>{
  let reads=0;
  const read=f.ports.readOffhost;
  f.ports.readOffhost=async(offset,size)=>{
    const response=await read(offset,size);
    if(++reads===1){
      assert.equal(f.adapter.observeNativeWriteCancelPending(),'MUTATION_UNKNOWN');
    }
    return response;
  };
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  f.ports.readOffhost=read;
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.equal(f.p.snapshot(sessionId).completionAttested,false);
  assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
}));

test('stale CORE owner epoch or revoked grant after signed witness never validates',async()=>{
  await scenario(async f=>{
    const read=f.ports.readPostcondition;
    f.ports.readPostcondition=async()=>{
      const value=await read();
      f.mutable.epoch++;
      return value;
    };
    assert.equal(await f.adapter.reconcile(f.signed),'CANCELLED_OR_STALE_CORE');
    assert.equal(await f.adapter.reconcile(f.signed),'CANCELLED_OR_STALE_CORE');
    assert.equal(f.p.snapshot(sessionId).completionAttested,false);
    assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
  });
  await scenario(async f=>{
    const grant=f.ports.readGrant;
    let reads=0;
    f.ports.readGrant=async()=>{
      const value=await grant();
      return ++reads>=4?{...value,state:'REVOKED'}:value;
    };
    assert.equal(await f.adapter.reconcile(f.signed),'CANCELLED_OR_STALE_CORE');
    assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
    assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
  });
});

test('terminal COMPLETED forged after native cancel pending remains UNKNOWN',()=>scenario(async f=>{
  const read=f.ports.readTransfer;
  let reads=0;
  f.ports.readTransfer=async()=>{
    const item=await read();
    reads++;
    return reads===1?{...item,state:'CANCEL_REQUESTED'}:item;
  };
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  // The next read is now a forged COMPLETED receipt. It must never be
  // observed, nor schedule a replay after the native-write outcome is unknown.
  f.ports.readTransfer=async()=>{throw Error('SHOULD_NOT_POLL_AFTER_UNKNOWN');};
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
}));

test('#725 forensic native ACK provenance on forged COMPLETED/CANCELLED is sticky UNKNOWN',async()=>{
  for(const [state,errorCode] of [
    ['COMPLETED','FORGED_WRITE_RECEIPT'],
    ['CANCELLED','FORGED_WRITE_RECEIPT'],
    ['COMPLETED','CORE_GRANT_EPOCH_STALE'],
    ['CANCELLED','CORE_OWNER_REVOKED'],
    ['COMPLETED','NATIVE_LEASE_EXPIRED'],
    ['MUTATION_UNKNOWN','TRANSFER_WRITE_OUTCOME_UNKNOWN'],
  ] as const){
    await scenario(async f=>{
      const normal=f.ports.readTransfer;
      let reads=0;
      f.ports.readTransfer=async()=>{
        reads++;
        return {...await normal(),state,errorCode};
      };
      f.ports.readOffhost=async()=>{throw Error('FORGED_RECEIPT_MUST_NOT_READ_OFFHOST');};
      assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN',
        state+'/'+errorCode);
      assert.equal(reads,1,'forensic outcome must not be retried or polled');
      f.ports.readTransfer=normal;
      assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
      assert.equal(reads,1);
      assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
      assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
    });
  }
});

test('#712 previously accepted owner CORE grant cannot authorize after revoke and epoch rotation',()=>scenario(async f=>{
  assert.equal(await f.adapter.reconcile(f.signed),'COMPLETED_VERIFIED');
  f.mutable.epoch=10;
  f.mutable.grantState='REVOKED';
  assert.equal(await f.adapter.reconcile(f.signed),'CANCELLED_OR_STALE_CORE');
  assert.equal(f.p.snapshot(sessionId).completionAttested,false);
  assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
  f.mutable.epoch=9;
  f.mutable.grantState='ACTIVE';
  assert.equal(await f.adapter.reconcile(f.signed),'CANCELLED_OR_STALE_CORE',
    'local terminal grant revocation cannot resurrect even with stale remote ACTIVE');
  assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
}));

test('stale Progress receipt after reconnect cannot restore off-host completion',()=>scenario(async f=>{
  assert.equal(await f.adapter.reconcile(f.signed),'COMPLETED_VERIFIED');
  f.p.invalidateOnReconnect();
  assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
  f.p.observeProcessEvent({topic:'process.output',data:{
    sessionId,stream:'stdout',seq:1,at:new Date(f.now()-2000).toISOString(),
    text:'NEXOWIRE_PROGRESS:{"completed_count":2,"pending_count":0,"failure_count":0}\n',
  }});
  assert.equal(f.p.snapshot(sessionId).completionAttested,false);
  assert.notEqual(await f.adapter.reconcile(f.signed),'COMPLETED_VERIFIED');
  assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
}));

test('#712 post-accept CORE revoke cannot leave cached COMPLETED_VERIFIED snapshot or replay',()=>scenario(async f=>{
  assert.equal(await f.adapter.reconcile(f.signed),'COMPLETED_VERIFIED');
  assert.equal(f.adapter.snapshot().status,'COMPLETED_VERIFIED');
  f.p.invalidateOwnerGrant(sessionId);
  assert.equal(f.p.snapshot(sessionId).completionAttested,false);
  assert.equal(f.adapter.snapshot().status,'MUTATION_UNKNOWN');
  assert.equal(f.adapter.snapshot().postconditionSha256,null);
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
  assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
}));

test('#725 late forensic errorCode arriving after valid signed postcondition cannot commit',()=>scenario(async f=>{
  const read=f.ports.readTransfer;
  let count=0;
  f.ports.readTransfer=async()=>{
    const receipt=await read();
    count++;
    return count>=3?{...receipt,errorCode:'FORGED_WRITE_RECEIPT'}:receipt;
  };
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.equal(f.adapter.snapshot().postconditionSha256,null);
  assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
  assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
}));

test('expired local immutable proof cannot remain cached COMPLETED_VERIFIED',()=>scenario(async f=>{
  assert.equal(await f.adapter.reconcile(f.signed),'COMPLETED_VERIFIED');
  f.setNow(f.now()+31_000);
  assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
  assert.equal(f.adapter.snapshot().status,'MUTATION_UNKNOWN');
  assert.equal(f.adapter.snapshot().postconditionSha256,null);
  f.ports.readTransfer=async()=>{throw Error('NO_REPOLL_AFTER_STALE_PROOF');};
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
}));

test('reconnect invalidates cached signed output snapshot before any new RPC',()=>scenario(async f=>{
  assert.equal(await f.adapter.reconcile(f.signed),'COMPLETED_VERIFIED');
  f.p.invalidateOnReconnect();
  assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
  assert.equal(f.adapter.snapshot().status,'MUTATION_UNKNOWN');
  assert.equal(f.adapter.snapshot().postconditionSha256,null);
  f.ports.readTransfer=async()=>{throw Error('NO_REPOLL_AFTER_RECONNECT');};
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
}));

test('#754 forged COMPLETED status with missing or forged final Native publication is UNKNOWN',async()=>{
  for(const kind of ['missing','forged','foreign'] as const)await scenario(async f=>{
    if(kind==='missing')f.mutable.missingNativePublication=true;
    if(kind==='forged')f.mutable.forgedNativePublication=true;
    if(kind==='foreign')f.mutable.foreignNativePublication=true;
    // Native status and independently rehashed metadata both appear
    // correct. They cannot substitute final publication authorization.
    assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN',kind);
    f.ports.readTransfer=async()=>{throw Error('NO_REPOLL_AFTER_UNKNOWN');};
    assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
    assert.equal(f.p.snapshot(sessionId).completionAttested,false);
    assert.equal(f.adapter.snapshot().postconditionSha256,null);
    assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
  });
});

test('#754 signed final receipt with stale durable publication ID or lease epoch rejects',async()=>{
  await scenario(async f=>{
    f.expected.publicationRequestId='550e8400-e29b-41d4-a716-446655440099';
    assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
    assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
  });
  await scenario(async f=>{
    f.expected.writerEpoch=8; // #754 writer epoch is not CORE owner epoch
    assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
    assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
  });
});

test('#752 reconnect orphan and #757 CORE revoke during final publication deny completion',async()=>{
  await scenario(async f=>{
    const read=f.ports.readFinalPublicationWitness;
    f.ports.readFinalPublicationWitness=async()=>{
      const proof=await read();
      f.p.invalidateOnReconnect();
      return proof;
    };
    assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
    assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
    assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
  });
  await scenario(async f=>{
    const read=f.ports.readFinalPublicationWitness;
    f.ports.readFinalPublicationWitness=async()=>{
      const proof=await read();
      f.mutable.grantState='REVOKED';
      return proof;
    };
    assert.equal(await f.adapter.reconcile(f.signed),'CANCELLED_OR_STALE_CORE');
    assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
    assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
  });
});

test('#768 Native signed final receipt without monotonic external commit is UNKNOWN',()=>scenario(async f=>{
  // A signed Native publication and matching transfer full SHA are NOT
  // the rollback-independent commitPublished authority in #768.
  f.mutable.noMonotonicCommit=true;
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.equal(f.p.snapshot(sessionId).completionAttested,false);
  assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
}));

test('#768 stale signed external commit from prior owner epoch cannot complete',()=>scenario(async f=>{
  f.mutable.staleCommitOwnerEpoch=true;
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
}));

test('#770 orphan UNKNOWN after signed final publish but before external commit cannot replay',()=>scenario(async f=>{
  const read=f.ports.readMonotonicPublicationCommit;
  f.ports.readMonotonicPublicationCommit=async()=>{
    await read();
    throw Error('CONNECTION_ORPHAN_NO_EXTERNAL_COMMIT_ACK');
  };
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  f.ports.readTransfer=async()=>{throw Error('MUST_NOT_REPOLL_ORPHAN');};
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.equal(f.p.snapshot(sessionId).completionAttested,false);
  assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
}));

test('#767 signed durable commit with CORE revoked before final readback is denied',()=>scenario(async f=>{
  const read=f.ports.readMonotonicPublicationCommit;
  f.ports.readMonotonicPublicationCommit=async()=>{
    const signed=await read();
    f.mutable.grantState='REVOKED';
    return signed;
  };
  assert.equal(await f.adapter.reconcile(f.signed),'CANCELLED_OR_STALE_CORE');
  assert.equal(f.p.snapshot(sessionId).completionAttested,false);
  assert.equal(f.adapter.snapshot().automaticReplayAllowed,false);
}));

test('#780 task-step checkpoint never attests running PID, counters or raw COMPLETED RPC',()=>scenario(async f=>{
  const before=f.adapter.taskStepCheckpointView();
  assert.equal(before.status,'UNKNOWN_NO_REPLAY');
  assert.equal(before.attestations.length,0);
  assert.equal(before.immutableOutputSha256,null);
  assert.equal(before.receiptStatus,'MUTATION_UNKNOWN');
  assert.equal(before.automaticReplayAllowed,false);
  assert.equal(before.checkpointPersisted,false);
  assert.ok(Buffer.byteLength(JSON.stringify(before),'utf8')<=4096);

  // Even all worker counters and a claimed transfer COMPLETED cannot attest
  // a durable task step without independently signed off-host proof.
  f.mutable.noMonotonicCommit=true;
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  const after=f.adapter.taskStepCheckpointView();
  assert.equal(after.attestations.length,0);
  assert.equal(after.immutableOutputSha256,null);
  assert.equal(after.receiptStatus,'MUTATION_UNKNOWN');
  assert.ok(Buffer.byteLength(JSON.stringify(after),'utf8')<=4096);
}));

test('#780 verified run-step exposes only bounded SHA/commit evidence from signed authorities',()=>scenario(async f=>{
  assert.equal(await f.adapter.reconcile(f.signed),'COMPLETED_VERIFIED');
  const checkpoint=f.adapter.taskStepCheckpointView();
  assert.equal(checkpoint.status,'SOURCE_VERIFIED_STEP');
  assert.equal(checkpoint.attestations.length,1);
  const step=checkpoint.attestations[0];
  assert.ok(step);
  assert.equal(step.taskStepRunId,runId);
  assert.equal(step.sessionId,sessionId);
  assert.equal(step.immutableOutputSha256,f.signed.statement.immutableObjectSha256);
  assert.equal(step.ownerGrantEpoch,9);
  assert.equal(step.durableCommitId,'550e8400-e29b-41d4-a716-446655440005');
  assert.equal(checkpoint.immutableOutputSha256,f.signed.statement.immutableObjectSha256);
  assert.equal(checkpoint.checkpointPersisted,false);
  assert.equal(checkpoint.productionAuthorityConnected,false);
  assert.equal(checkpoint.automaticReplayAllowed,false);
  assert.ok(Buffer.byteLength(JSON.stringify(checkpoint),'utf8')<=4096);
  assert.ok(Object.isFrozen(checkpoint.attestations));
}));

test('#780 revoked CORE with old owner_epoch plus forged COMPLETED never revives checkpoint',()=>scenario(async f=>{
  assert.equal(await f.adapter.reconcile(f.signed),'COMPLETED_VERIFIED');
  assert.equal(f.adapter.taskStepCheckpointView().attestations.length,1);
  // An authoritative owner-revoke event invalidates a previously signed
  // result even if stale Native/Hub status still says COMPLETED.
  f.p.invalidateOwnerGrant(sessionId);
  f.mutable.grantState='ACTIVE';
  f.mutable.epoch=9;
  const stale=f.adapter.taskStepCheckpointView();
  assert.equal(stale.status,'UNKNOWN_NO_REPLAY');
  assert.equal(stale.attestations.length,0);
  assert.equal(stale.immutableOutputSha256,null);
  assert.equal(stale.receiptStatus,'MUTATION_UNKNOWN');
  let called=0;
  f.ports.readTransfer=async()=>{called++;throw Error('MUST_NOT_REPLAY');};
  const forged={...f.signed,signatureBase64:Buffer.alloc(64).toString('base64')};
  assert.equal(await f.adapter.reconcile(forged),'MUTATION_UNKNOWN');
  assert.equal(await f.adapter.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.equal(called,0);
  assert.equal(f.p.snapshot(sessionId).completionAttested,false);
  assert.equal(f.adapter.taskStepCheckpointView().attestations.length,0);
  assert.equal(f.adapter.taskStepCheckpointView().automaticReplayAllowed,false);
}));

test('#781 cloned runbook/run ID cannot adopt previous immutable dispatch receipt',()=>scenario(async f=>{
  const clonedRunId='qa18-cloned-runbook';
  const keys={
    issuer:issuer.publicKey,immutableStorage:storage.publicKey,
    publication:publication.publicKey,monotonicCommit:monotonicCommit.publicKey,
    postcondition:witness.publicKey,
  };
  const clone=new ProgressRuntimePostconditionAdapter(f.p,{
    ...f.request,scope:{...f.request.scope,runId:clonedRunId},
  },{...f.expected,runId:clonedRunId},keys,f.ports,f.now);
  assert.equal(clone.taskStepCheckpointView().attestations.length,0);
  assert.equal(await clone.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
  assert.equal(clone.taskStepCheckpointView().immutableOutputSha256,null);
  assert.equal(clone.taskStepCheckpointView().automaticReplayAllowed,false);
  assert.equal(await clone.reconcile(f.signed),'MUTATION_UNKNOWN');
}));

test('#781 rebooted Progress with forged PID/stdout and old signed COMPLETED stays UNKNOWN',()=>scenario(async f=>{
  const rebooted=new ProgressSupervisor({now:f.now,stallAfterMs:1000});
  rebooted.register(sessionId);
  assert.equal(rebooted.bindTrustedRequest(sessionId,requestId),true);
  rebooted.recover([{sessionId,status:'exited',exitCode:0}]);
  // Replayed/forged stdout after a reboot is not an observed live
  // process exit/result hash on this new supervisor instance.
  rebooted.observeProcessEvent({topic:'process.output',data:{
    sessionId,stream:'stdout',text:
      'NEXOWIRE_PROGRESS:{"completed_count":2,"pending_count":0,"failure_count":0}\n',
  }});
  const keys={
    issuer:issuer.publicKey,immutableStorage:storage.publicKey,
    publication:publication.publicKey,monotonicCommit:monotonicCommit.publicKey,
    postcondition:witness.publicKey,
  };
  const projected=new ProgressRuntimePostconditionAdapter(rebooted,
    f.request,{...f.expected},keys,f.ports,f.now);
  assert.equal(projected.taskStepCheckpointView().attestations.length,0);
  assert.equal(await projected.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.equal(projected.taskStepCheckpointView().status,'UNKNOWN_NO_REPLAY');
  assert.equal(projected.taskStepCheckpointView().immutableOutputSha256,null);
  const reads=f.mutable.transferReads;
  assert.equal(await projected.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.equal(f.mutable.transferReads,reads,'no replay or repeated status poll');
  assert.equal(rebooted.snapshot(sessionId).completionAttested,false);
}));

test('#781 owner revoked then cloned adapter with stale ACTIVE readback cannot renew COMPLETED',()=>scenario(async f=>{
  assert.equal(await f.adapter.reconcile(f.signed),'COMPLETED_VERIFIED');
  f.p.invalidateOwnerGrant(sessionId);
  // A cloned *checkpoint ID* cannot replace immutable dispatch identity;
  // stale cached remote grant is adversarially still ACTIVE at old epoch.
  f.mutable.grantState='ACTIVE';
  f.mutable.epoch=9;
  const keys={
    issuer:issuer.publicKey,immutableStorage:storage.publicKey,
    publication:publication.publicKey,monotonicCommit:monotonicCommit.publicKey,
    postcondition:witness.publicKey,
  };
  const clone=new ProgressRuntimePostconditionAdapter(f.p,f.request,
    {...f.expected},keys,f.ports,f.now);
  assert.equal(clone.taskStepCheckpointView().attestations.length,0);
  assert.equal(await clone.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.equal(clone.taskStepCheckpointView().receiptStatus,'MUTATION_UNKNOWN');
  assert.equal(clone.taskStepCheckpointView().immutableOutputSha256,null);
  const reads=f.mutable.transferReads;
  assert.equal(await clone.reconcile(f.signed),'MUTATION_UNKNOWN');
  assert.equal(f.mutable.transferReads,reads);
  assert.notEqual(f.p.snapshot(sessionId).state,'completed_verified');
}));
