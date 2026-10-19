import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  ProgressSupervisor, PROGRESS_PREFIX, evaluateRetryPolicy,
} from '../src/agent/progress-supervisor.js';
import {verifyResultFiles, type ProgressProofRequest} from '../src/agent/progress-proof-verifier.js';
import {verifyProgressProofRequestFile} from '../scripts/verify-progress-proof.js';

const fixture = path.resolve('test/fixtures/progress-result-worker-fixture.cjs');
const scope = {ownerAccountId:'owner-fixture',deviceId:'device-fixture',
  projectId:'project-fixture',runId:'run-fixture',sessionId:'session-fixture'};
async function withWorker(mode:'complete'|'false_progress'|'tampered'|'failed'|'gpu_silent',
  run: (args:{request:ProgressProofRequest; supervisor:ProgressSupervisor;
    root:string; output:string; clock:{now:number}})=>Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-proof-fixture-'));
  const clock = {now:Date.now()};
  const supervisor = new ProgressSupervisor({now:()=>clock.now,stallAfterMs:100});
  supervisor.register(scope.sessionId);
  try {
    const output=execFileSync(process.execPath,[fixture,root,mode,scope.runId,scope.sessionId], {
      encoding:'utf8', timeout:5000, windowsHide:true, maxBuffer:16384,
    });
    assert.match(output,/^NEXOWIRE_PROGRESS_V1 /);
    supervisor.observeProcessEvent({topic:'process.output',data:{
      sessionId:scope.sessionId,stream:'stdout',text:output,
    }});
    await run({request:{runRoot:root,scope:{...scope},expectedCount:2},
      supervisor,root,output,clock});
  } finally { await fs.rm(root,{recursive:true,force:true}); }
}

test('controlled worker: PID and heartbeat are not verified completion; actual result files are',async()=>{
  await withWorker('complete',async({request,supervisor,clock})=>{
    const before=supervisor.snapshot(scope.sessionId);
    assert.equal(before.state,'active');
    assert.equal(before.progressVerified,false);
    assert.equal(before.lastVerifiedProgressAt,null);
    const disk=await verifyResultFiles(request);
    assert.equal(disk.status,'verified');
    assert.deepEqual([disk.completedCount,disk.pendingCount,disk.failureCount],[2,0,0]);
    assert.equal(disk.sealed,true);
    const live=await supervisor.verifySessionFromDisk(scope.sessionId,request);
    assert.equal(live.status,'verified');
    assert.equal(supervisor.snapshot(scope.sessionId).state,'active');
    assert.equal(supervisor.snapshot(scope.sessionId).progressVerified,true);
    assert.equal(supervisor.snapshot(scope.sessionId).completedCount,2);
    supervisor.observeProcessEvent({topic:'process.exited',data:{
      sessionId:scope.sessionId,exitCode:0,
    }});
    assert.equal(supervisor.snapshot(scope.sessionId).state,'reported_complete');
    const terminal=await supervisor.verifySessionFromDisk(scope.sessionId,request);
    assert.equal(terminal.status,'verified');
    const after=supervisor.snapshot(scope.sessionId);
    assert.equal(after.state,'completed_verified');
    assert.equal(after.completionEvidence,'result_files_rehashed_scope_bound');
    assert.equal(after.resultArtifactSha256Verified,disk.artifactSha256);
    assert.equal(after.progressVerified,true);
    assert.equal(after.lastVerifiedProgressAt,new Date(clock.now).toISOString());
    assert.equal(after.restartAllowed,false);
  });
});

test('lying stdout completed and pending counters are rejected against real files',async()=>{
  await withWorker('false_progress',async({request,supervisor})=>{
    const raw=supervisor.snapshot(scope.sessionId);
    assert.equal(raw.completedCount,2);
    assert.equal(raw.progressVerified,false);
    const evidence=await supervisor.verifySessionFromDisk(scope.sessionId,request);
    assert.equal(evidence.status,'unverified');
    assert.equal(evidence.reason,'WORKER_REPORT_MISMATCH');
    const snapshot=supervisor.snapshot(scope.sessionId);
    assert.equal(snapshot.state,'progress_mismatch');
    assert.equal(snapshot.progressVerified,false);
    assert.equal(snapshot.lastVerifiedProgressAt,null);
    assert.equal(supervisor.scan()[0]?.code,'EVIDENCE_MISMATCH');
    assert.equal(supervisor.scan().length,0);
  });
});

test('modified result bytes invalidate an otherwise plausible worker hash and final exit',async()=>{
  await withWorker('tampered',async({request,supervisor})=>{
    supervisor.observeProcessEvent({topic:'process.exited',data:{
      sessionId:scope.sessionId,exitCode:0,
    }});
    assert.equal(supervisor.snapshot(scope.sessionId).state,'reported_complete');
    const proof=await supervisor.verifySessionFromDisk(scope.sessionId,request);
    assert.equal(proof.status,'unverified');
    assert.equal(proof.reason,'RESULT_HASH_MISMATCH');
    assert.equal(supervisor.snapshot(scope.sessionId).state,'progress_mismatch');
    assert.equal(supervisor.snapshot(scope.sessionId).progressVerified,false);
  });
});

test('failed result and worker failure counter are verified, but never completion success',async()=>{
  await withWorker('failed',async({request,supervisor})=>{
    supervisor.observeProcessEvent({topic:'process.exited',data:{
      sessionId:scope.sessionId,exitCode:0,
    }});
    const report=await supervisor.verifySessionFromDisk(scope.sessionId,request);
    assert.deepEqual([report.status,report.completedCount,report.failureCount],
      ['verified',1,1]);
    const snapshot=supervisor.snapshot(scope.sessionId);
    assert.equal(snapshot.state,'failed');
    assert.equal(snapshot.progressVerified,true);
    assert.notEqual(snapshot.state,'completed_verified');
  });
});

test('owner, device, project, session and scheduled total are independently required',async()=>{
  await withWorker('complete',async({request,root})=>{
    for(const field of ['ownerAccountId','deviceId','projectId','runId','sessionId'] as const){
      const r=await verifyResultFiles({...request,scope:{...request.scope,[field]:'foreign-id'}});
      assert.equal(r.status,'unverified');
      assert.equal(r.reason,'SCOPE_MISMATCH');
    }
    const count=await verifyResultFiles({...request,expectedCount:1});
    assert.equal(count.reason,'SCOPE_MISMATCH');
    const outside=await verifyResultFiles({...request,runRoot:path.join(root,'none')});
    assert.equal(outside.status,'unverified');
  });
});

test('duplicated results, missing files and result identity drift fail closed',async()=>{
  await withWorker('complete',async({request,root})=>{
    const manifestFile=path.join(root,'manifest.json');
    const original=JSON.parse(await fs.readFile(manifestFile,'utf8'));
    original.artifacts[1].itemId=original.artifacts[0].itemId;
    await fs.writeFile(manifestFile,JSON.stringify(original));
    assert.equal((await verifyResultFiles(request)).reason,'DUPLICATE_RESULT');
    original.artifacts[1].itemId='unit-1';
    original.artifacts[1].filename='not-there.json';
    await fs.writeFile(manifestFile,JSON.stringify(original));
    assert.equal((await verifyResultFiles(request)).status,'unverified');
    original.artifacts[1].filename='unit-1.json';
    await fs.writeFile(manifestFile,JSON.stringify(original));
    const filepath=path.join(root,'results','unit-1.json');
    const payload=JSON.stringify({schemaVersion:1,runId:'foreign-run',
      itemId:'unit-1',outcome:'completed'});
    await fs.writeFile(filepath,payload);
    original.artifacts[1].sha256=createHash('sha256').update(payload).digest('hex');
    await fs.writeFile(manifestFile,JSON.stringify(original));
    assert.equal((await verifyResultFiles(request)).reason,'RESULT_IDENTITY_MISMATCH');
  });
});

test('symlinked artifact is rejected even if pointed-to bytes have a matching hash',async(t)=>{
  await withWorker('complete',async({request,root})=>{
    const target=path.join(root,'results','unit-0.json');
    const link=path.join(root,'results','substitute.json');
    try { await fs.symlink(target,link,'file'); }
    catch { t.diagnostic('Windows symlink privilege unavailable: negative test skipped'); return; }
    const mf=path.join(root,'manifest.json');
    const manifest=JSON.parse(await fs.readFile(mf,'utf8'));
    manifest.artifacts[0].filename='substitute.json';
    await fs.writeFile(mf,JSON.stringify(manifest));
    assert.equal((await verifyResultFiles(request)).reason,'FILE_UNTRUSTED');
  });
});

test('GPU saturated reported without verified output: stalled, not completed nor GPU root-cause proven',async()=>{
  await withWorker('gpu_silent',async({request,supervisor,clock})=>{
    const before=supervisor.snapshot(scope.sessionId);
    assert.equal(before.state,'active');
    assert.equal(before.progressVerified,false);
    assert.equal(before.diagnosis,'gpu_saturated');
    clock.now+=150;
    assert.equal(supervisor.snapshot(scope.sessionId).state,'stalled');
    const warning=supervisor.scan()[0];
    assert.equal(warning?.code,'NO_COMPLETIONS');
    assert.equal(warning?.diagnosis,'gpu_saturated');
    assert.equal(warning?.certainty,'suspected');
    assert.equal(warning?.restartAllowed,false);
    const disk=await verifyResultFiles(request);
    assert.equal(disk.status,'verified');
    assert.equal(disk.completedCount,0);
    assert.equal(disk.pendingCount,2);
    assert.equal(supervisor.snapshot(scope.sessionId).state,'stalled');
  });
});

test('queue growing without results takes precedence over worker GPU/rate-limit explanation',()=>{
  let now=0;
  const p=new ProgressSupervisor({now:()=>now,stallAfterMs:100});
  p.register('queue');
  p.observeMetrics('queue',{completed_count:0,pending_count:10,
    failure_count:0,diagnosis:'gpu_saturated'});
  now=20;
  p.observeMetrics('queue',{completed_count:0,pending_count:30,
    failure_count:0,diagnosis:'gpu_saturated'});
  now=155;
  assert.equal(p.snapshot('queue').state,'stalled');
  const w=p.scan()[0];
  assert.equal(w?.code,'QUEUE_GROWING_WITHOUT_COMPLETIONS');
  assert.equal(w?.diagnosis,'gpu_saturated');
  assert.equal(w?.restartAllowed,false);
});

test('reconnection discards old PID reports and disk proof without replay',async()=>{
  await withWorker('complete',async({request,supervisor})=>{
    await supervisor.verifySessionFromDisk(scope.sessionId,request);
    assert.equal(supervisor.snapshot(scope.sessionId).progressVerified,true);
    supervisor.invalidateOnReconnect();
    const p=supervisor.snapshot(scope.sessionId);
    assert.equal(p.state,'progress_unknown');
    assert.equal(p.completedCount,null);
    assert.equal(p.progressVerified,false);
    assert.equal(p.verificationReason,'RECONNECT_REVERIFY_REQUIRED');
    assert.equal(supervisor.scan()[0]?.code,'RECONNECT_PROOF_EXPIRED');
    assert.equal(evaluateRetryPolicy({effect:'unknown',retryBudget:9,attemptsUsed:0,
      ownerApproved:true,processTerminatedAndReconciled:false}).restartAllowed,false);
    assert.equal((await supervisor.verifySessionFromDisk(scope.sessionId,request)).status,
      'unverified');
  });
});


test('result-file modification timestamp later than reported progress cannot validate past claim',async()=>{
  await withWorker('complete',async({request,supervisor,root,clock})=>{
    const target=path.join(root,'results','unit-0.json');
    const future=new Date(clock.now+15_000);
    await fs.utimes(target,future,future);
    const proof=await supervisor.verifySessionFromDisk(scope.sessionId,request);
    assert.equal(proof.status,'unverified');
    assert.equal(proof.reason,'WORKER_REPORT_MISMATCH');
    assert.equal(supervisor.snapshot(scope.sessionId).state,'progress_mismatch');
  });
});

test('hardlinked artifacts fail closed even when contents and hashes are correct',async()=>{
  await withWorker('complete',async({request,root})=>{
    const existing=path.join(root,'results','unit-0.json');
    const alias=path.join(root,'results','unit-0-alias.json');
    await fs.link(existing,alias);
    const manifestFile=path.join(root,'manifest.json');
    const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));
    manifest.artifacts[0].filename='unit-0-alias.json';
    await fs.writeFile(manifestFile,JSON.stringify(manifest));
    assert.equal((await verifyResultFiles(request)).reason,'FILE_UNTRUSTED');
  });
});

test('a new sample racing independent verification never inherits old proof',async()=>{
  await withWorker('complete',async({request,supervisor})=>{
    const attempt=supervisor.verifySessionFromDisk(scope.sessionId,request);
    supervisor.observeMetrics(scope.sessionId,{
      completed_count:2,pending_count:0,failure_count:0,
      result_artifact_sha256:'a'.repeat(64),
    });
    const result=await attempt;
    assert.equal(result.status,'unverified');
    assert.equal(result.reason,'PROOF_RACE_REVERIFY');
    assert.equal(supervisor.snapshot(scope.sessionId).progressVerified,false);
  });
});

test('unexpected process identity transition invalidates cached independent proof',async()=>{
  await withWorker('complete',async({request,supervisor})=>{
    assert.equal((await supervisor.verifySessionFromDisk(scope.sessionId,request)).status,'verified');
    supervisor.recover([{sessionId:scope.sessionId,status:'lost',exitCode:null}]);
    const proof=supervisor.snapshot(scope.sessionId);
    assert.equal(proof.state,'lost');
    assert.equal(proof.progressVerified,false);
    assert.equal((await supervisor.verifySessionFromDisk(scope.sessionId,request)).reason,
      'NO_TRUSTED_LIVE_SAMPLE');
  });
});


test('operator-only offline verifier checks files but cannot assert process completion',async()=>{
  await withWorker('complete',async({request,root})=>{
    const descriptor=path.join(root,'trusted-descriptor.json');
    await fs.writeFile(descriptor,JSON.stringify(request));
    const result=await verifyProgressProofRequestFile(descriptor) as Record<string,unknown>;
    assert.equal(result.status,'verified');
    assert.equal(result.completedCount,2);
    assert.equal(result.completedVerified,false);
    assert.equal(result.processExitIndependentlyAttested,false);
    assert.equal(result.noWorkerWasExecuted,true);
    await assert.rejects(()=>verifyProgressProofRequestFile('relative-descriptor.json'),
      /TRUSTED_REQUEST_FILE_REQUIRED/);
  });
});


test('verified completion cache expires instead of hiding subsequent file changes',async()=>{
  await withWorker('complete',async({request,supervisor,clock,root})=>{
    supervisor.observeProcessEvent({topic:'process.exited',data:{
      sessionId:scope.sessionId,exitCode:0,
    }});
    await supervisor.verifySessionFromDisk(scope.sessionId,request);
    assert.equal(supervisor.snapshot(scope.sessionId).state,'completed_verified');
    clock.now+=30_100;
    const expired=supervisor.snapshot(scope.sessionId);
    assert.equal(expired.state,'reported_complete');
    assert.equal(expired.progressVerified,false);
    assert.equal(expired.lastVerifiedProgressAt,null);
    assert.equal(expired.verificationReason,'DISK_PROOF_STALE_REVERIFY');
    assert.equal(supervisor.scan()[0]?.code,'DISK_PROOF_STALE');
    await fs.appendFile(path.join(root,'results','unit-0.json'),'TAMPER');
    const refreshed=await supervisor.verifySessionFromDisk(scope.sessionId,request);
    assert.equal(refreshed.status,'unverified');
    assert.equal(refreshed.reason,'RESULT_HASH_MISMATCH');
    assert.equal(supervisor.snapshot(scope.sessionId).state,'progress_mismatch');
  });
});

test('matching result hashes and zero pending never override failed or unknown process exit',async()=>{
  await withWorker('complete',async({request,supervisor})=>{
    // Process outcome remains independent from application self-report.
    const observed=await supervisor.verifySessionFromDisk(scope.sessionId,request);
    assert.equal(observed.status,'verified');
    supervisor.observeProcessEvent({topic:'process.exited',data:{
      sessionId:scope.sessionId,exitCode:17,
    }});
    assert.equal(supervisor.snapshot(scope.sessionId).state,'failed');
    await supervisor.verifySessionFromDisk(scope.sessionId,request);
    assert.equal(supervisor.snapshot(scope.sessionId).state,'failed');
    assert.notEqual(supervisor.snapshot(scope.sessionId).state,'completed_verified');
  });
  await withWorker('complete',async({request,supervisor})=>{
    supervisor.observeProcessEvent({topic:'process.exited',data:{
      sessionId:scope.sessionId,exitCode:null,
    }});
    const evidence=await supervisor.verifySessionFromDisk(scope.sessionId,request);
    assert.equal(evidence.status,'verified');
    const snapshot=supervisor.snapshot(scope.sessionId);
    assert.equal(snapshot.state,'incomplete');
    assert.notEqual(snapshot.state,'completed_verified');
  });
});

test('oversized result with updated plausible hash still fails closed',async()=>{
  await withWorker('complete',async({request,root,supervisor})=>{
    const resultPath=path.join(root,'results','unit-0.json');
    const body=Buffer.alloc(129*1024,0x20);
    const manifestPath=path.join(root,'manifest.json');
    await fs.writeFile(resultPath,body);
    const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
    manifest.artifacts[0].sha256=createHash('sha256').update(body).digest('hex');
    await fs.writeFile(manifestPath,JSON.stringify(manifest));
    supervisor.observeProcessEvent({topic:'process.exited',data:{
      sessionId:scope.sessionId,exitCode:0,
    }});
    const evidence=await supervisor.verifySessionFromDisk(scope.sessionId,request);
    assert.equal(evidence.status,'unverified');
    assert.equal(evidence.reason,'FILE_UNTRUSTED');
    assert.equal(supervisor.snapshot(scope.sessionId).state,'progress_mismatch');
    assert.equal(supervisor.snapshot(scope.sessionId).progressVerified,false);
  });
});
