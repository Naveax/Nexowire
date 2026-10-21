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
    readImmutableSeal:async()=>({
      ...sealPayload,
      signatureBase64:sign(null,canonicalImmutableSeal(sealPayload),
        storage.privateKey).toString('base64'),
    }),
    readPostcondition:async()=>mutable.witness,
  };
  const expected={
    ...scope,requestId,grantId:s.grantId,ownerGrantEpoch:9,
    sourceDeviceId:deviceId,targetDeviceId:s.targetDeviceId,targetPath:s.targetPath,
    resultSetSha256:s.resultSetSha256,outputProofSha256:s.outputProofSha256,
    completedCount:2,exitObservedAt:s.exitObservedAt,
  };
  const adapter=new ProgressRuntimePostconditionAdapter(p,proofRequest,expected,{
    issuer:issuer.publicKey,immutableStorage:storage.publicKey,
    postcondition:witness.publicKey,
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
