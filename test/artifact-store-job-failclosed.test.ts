import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CrossDeviceTransferJobs, type TransferRemote, type TransferJob
} from '../src/mcp/cross-device-transfer-jobs.js';
import { TransferTrustError, type TrustedTransferAuthority
} from '../src/workspace/artifact-job-trust.js';
import { StagingArtifactByteBudget, initArtifactBudgetFixture
} from '../src/ops/scale-v2-artifact-byte-budget-staging.js';
import { StagingJobBudgetGate } from '../src/workspace/artifact-job-budget-staging.js';
import { ArtifactBridgeStore, ArtifactBridgeError } from '../src/workspace/artifact-bridge.js';
import { VerifiedTransferCheckpointAdapter } from '../src/workspace/artifact-job-checkpoint.js';

const bytes = Buffer.alloc(221 * 1024, 73);
const digest = createHash('sha256').update(bytes).digest('hex');
const args = { accountId: 'account:synthetic-owner', projectId: 'Nexowire',
  sourceDeviceId: 'workpc-fixture', targetDeviceId: 'naveax-fixture',
  sourcePath: '/synthetic/source.bin', targetPath: '/synthetic/destination.bin' };
const ops = (): TransferRemote => ({
  stat: async () => ({ type: 'file', size: bytes.length }),
  hash: async () => digest,
  read: async (_device, _path, offset, limit) => {
    const chunk = bytes.subarray(offset, offset + limit);
    return { sourceBytes: bytes.length, offsetBytes: offset, bytesRead: chunk.length,
      contentBase64: chunk.toString('base64') };
  },
  write: async () => { throw Error('MUST_NOT_WRITE'); },
  moveNoOverwrite: async () => { throw Error('MUST_NOT_PUBLISH'); },
});
async function fixture(run: (root: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-08-failclosed-'));
  try { await run(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
function mockJob(): TransferJob {
  const date = new Date().toISOString();
  return {
    version: 1, id: randomUUID(), ...args, // explicitly map actual job property names
    accountId: args.accountId, projectId: args.projectId,
    sourceDeviceId: args.sourceDeviceId, targetDeviceId: args.targetDeviceId,
    sourcePath: args.sourcePath, targetPath: args.targetPath,
    stagePath: '/synthetic/stage',
    bytesTotal: bytes.length, bytesConfirmed: 0, sha256: digest,
    state: 'QUEUED', createdAt: date, updatedAt: date,
  };
}
test('hosted fail closed: no independent monotonic authority -> no mutating writes', async () =>
  fixture(async root => {
    let writes = 0;
    const remote: TransferRemote = { ...ops(),
      write: async () => { writes++; return 65536; },
      writeFenced: async () => { writes++; throw Error('NEVER_ALLOWED'); },
      publishFenced: async () => { writes++; throw Error('NEVER_ALLOWED'); },
    };
    const grants = { assertCurrent: async () => undefined };
    const jobs = new CrossDeviceTransferJobs(root, remote,
      { requireExternalAuthority: true, grants });
    await assert.rejects(jobs.start(args), (e: unknown) =>
      e instanceof TransferTrustError && e.code === 'EXTERNAL_AUTHORITY_REQUIRED');
    assert.equal(writes, 0);
    const names = await fs.readdir(root);
    assert.deepEqual(names, []);
  }));
test('#587 two-stage co-rollback modeled by independent monotonic authority: stale job rejected', async () =>
  fixture(async root => {
    const independent = new Map<string, { epoch: number; highwater: number }>();
    const authority: TrustedTransferAuthority = {
      acquire: async (job, mode) => {
        const prev = independent.get(job.id);
        if (mode === 'resume' && prev && job.bytesConfirmed < prev.highwater) {
          throw new TransferTrustError('EXTERNAL_ROLLBACK_DETECTED',
            'Durable local checkpoint predates external monotonic write highwater.');
        }
        const epoch = (prev?.epoch ?? 0) + 1;
        independent.set(job.id, { epoch, highwater: prev?.highwater ?? 0 });
        return { epoch, token: 'external-test-monotonic-' + job.id + '-' + epoch };
      },
      assertCurrent: async (job, lease, _phase, offset) => {
        const prev = independent.get(job.id);
        if (!prev || lease.epoch !== prev.epoch) {
          throw new TransferTrustError('STALE_LEASE_FENCE', 'Former Hub is fenced.');
        }
        prev.highwater = Math.max(prev.highwater, offset);
      },
    };
    let stage = Buffer.alloc(0);
    let stop = true;
    const remote: TransferRemote = {
      ...ops(),
      stat: async (device, file) => {
        if (device === args.targetDeviceId && file !== args.targetPath) {
          return { type: 'file', size: stage.length };
        }
        return { type: 'file', size: bytes.length };
      },
      hash: async (device) => device === args.sourceDeviceId
        ? digest : createHash('sha256').update(stage).digest('hex'),
      read: async (device, _file, offset, length) => {
        const actual = (device === args.targetDeviceId ? stage : bytes);
        const chunk = actual.subarray(offset, offset + length);
        return { sourceBytes: actual.length, offsetBytes: offset, bytesRead: chunk.length,
          contentBase64: chunk.toString('base64') };
      },
      write: async (_device, _file, encoded, first, offset) => {
        const chunk = Buffer.from(encoded, 'base64');
        if (first) stage = chunk;
        else if (offset === stage.length) stage = Buffer.concat([stage, chunk]);
        else throw Error('WRONG_OFFSET');
        if (stop) { stop = false; throw Error('LOST_ACK'); }
        return chunk.length;
      },
      writeFenced: async (_job, env, encoded, first) => {
        const written = await remote.write(args.targetDeviceId, '/stage',
          encoded, first, env.offset);
        assert.equal(written, env.length);
        return { requestId: env.requestId, epoch: env.epoch, offset: env.offset,
          length: env.length, sha256: env.sha256 };
      },
      publishFenced: async () => { throw Error('SHOULD_NOT_PUBLISH'); },
    };
    const grants = { assertCurrent: async () => undefined };
    const first = new CrossDeviceTransferJobs(root, remote,
      { requireExternalAuthority: true, authority, grants });
    const started = await first.start(args);
    for (let n=0;n<100;n++) {
      const s = await first.status(started.id,args.accountId,args.sourceDeviceId,args.targetDeviceId);
      if (s.state === 'MUTATION_UNKNOWN') break;
      await new Promise(done=>setTimeout(done, 10));
    }
    await first.waitForIdle(started.id);
    const local = JSON.parse(await fs.readFile(path.join(root,started.id+'.json'),'utf8')) as TransferJob;
    assert.equal(local.state, 'MUTATION_UNKNOWN');
    // Independent authority continues to advance after a newly confirmed
    // chunk. Rollback J and its local companion A together to old snapshot.
    const record = independent.get(started.id)!;
    record.highwater = 131072;
    const second = new CrossDeviceTransferJobs(root, remote,
      { requireExternalAuthority: true, authority, grants });
    await assert.rejects(second.start({ ...args, resumeTransferId: started.id }),
      (e: unknown) => e instanceof TransferTrustError &&
        e.code === 'EXTERNAL_ROLLBACK_DETECTED');
    assert.equal(stage.length, 65536);
  }));
test('#601 staged quota: cancel tombstones reservation; no refund without trusted writer fence', async () =>
  fixture(async root => {
    const db = new DatabaseSync(path.join(root, 'budget.sqlite'));
    try {
      db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;');
      initArtifactBudgetFixture(db);
      const budget = new StagingArtifactByteBudget(db);
      const job = mockJob();
      const gate = new StagingJobBudgetGate(budget,
        async () => 8 * 1024 * 1024 * 1024, () => new Date('2026-10-21T12:00:00Z'));
      await gate.reserve(job);
      await gate.cancel(job);
      await assert.rejects(gate.acknowledgeVerifiedDeletion(job), /TRUSTED_WRITER_DELETION_UNAVAILABLE/);
      await assert.rejects(gate.reserve(job), /BUDGET_FAIL_CLOSED_DENIED_STATE/);
      const reserved = db.prepare('SELECT state, size_bytes AS size FROM budget_artifact_sessions').get() as {state:string;size:number};
      assert.equal(reserved.state, 'CANCEL_PENDING');
      assert.equal(reserved.size, bytes.length);
      const fenced = new StagingJobBudgetGate(budget,
        async () => 8 * (1024**3), () => new Date('2026-10-21T12:00:00Z'), {
          attest: async () => ({ durableDeletionVerified: true, writersStoppedVerified: true }),
        });
      await fenced.acknowledgeVerifiedDeletion(job);
      const after = db.prepare('SELECT state FROM budget_artifact_sessions').get() as {state:string};
      assert.equal(after.state, 'RELEASED');
    } finally { db.close(); }
  }));

test('checkpoint adapter never treats job COMPLETED or a wrong digest as verified artifact', async () =>
  fixture(async root => {
    const bridge = new ArtifactBridgeStore(path.join(root, 'verified-store'));
    let grantActive = true;
    const authoritativeRequestId = randomUUID();
    const authoritativeCommitId = 'independent-monotonic-commit-'+randomUUID();
    const adapter = new VerifiedTransferCheckpointAdapter(bridge, {
      assertCurrent: async () => {
        if (!grantActive) throw new TransferTrustError('CORE_OWNER_REVOKED','CORE grant revoked');
      },
    }, {
      // Isolated TEST-ONLY off-host readback. Never derive these fields from
      // the mutable job, MCP caller JSON or local COMPLETED journal.
      inspect: async () => ({
        jobId: job.id, requestId: authoritativeRequestId, epoch: 5,
        sha256: digest, durableCommitId: authoritativeCommitId,
      }),
      // Synthetic ONLY: the real protected provider must independently hold
      // a durable owner/grant epoch fence across the callback's fsync/rename.
      saveIfCurrent: async (_job, write) => {
        if (!grantActive) throw new TransferTrustError('CORE_OWNER_REVOKED','CORE grant revoked');
        return write();
      },
    });
    const job = mockJob();
    const scope = { accountId: job.accountId, projectId: job.projectId,
      deviceId: job.targetDeviceId };
    const input = { scope, job, workspaceId: 'nexowire-08-checkpoint',
      artifactPath: 'transfer/proven.bin',
      repository: 'Naveax/Nexowire', commitSha: 'a'.repeat(40) };
    await assert.rejects(adapter.persist(input),
      (e: unknown) => e instanceof ArtifactBridgeError && e.code === 'JOB_NOT_VERIFIED');
    const done: TransferJob = { ...job, state: 'COMPLETED',
      bytesConfirmed: bytes.length, fencing: { epoch: 5, token: 'f'.repeat(64) },
      publication: {requestId: authoritativeRequestId,epoch: 5,
        sha256:digest,dispatched:true,durableCommitId: authoritativeCommitId} };
    await assert.rejects(adapter.persist({ ...input, job: done }),
      (e: unknown) => e instanceof ArtifactBridgeError &&
        e.code === 'JOB_ARTIFACT_ATTESTATION_MISSING');
    const staged = await bridge.begin({ scope, artifactPath: input.artifactPath,
      repository: input.repository, commitSha: input.commitSha,
      producerOperationId: job.id, size: bytes.length, sha256: digest,
      testStatus: 'unverified', acceptanceStatus: 'pending' });
    assert.equal(staged.state, 'OPEN');
    for (let offset = 0; offset < bytes.length; offset += 65536) {
      const chunk = bytes.subarray(offset, offset + 65536);
      await bridge.putChunk(scope, staged.sessionId!, offset, chunk.toString('base64'));
    }
    await bridge.commit(scope, staged.sessionId!);
    const readonlyWitness = new VerifiedTransferCheckpointAdapter(bridge,
      { assertCurrent: async () => undefined }, {
        inspect: async () => ({ jobId: job.id, requestId: authoritativeRequestId,
          epoch: 5, sha256: digest, durableCommitId: authoritativeCommitId }),
      });
    await assert.rejects(readonlyWitness.persist({ ...input, job: done }),
      (e:unknown)=>e instanceof ArtifactBridgeError &&
        e.code==='JOB_CHECKPOINT_ATOMIC_ADMISSION_REQUIRED');
    assert.equal(await bridge.getCheckpoint(scope,input.workspaceId),null,
      'independent readback alone cannot write a checkpoint');
    const checkpoint = await adapter.persist({ ...input, job: done });
    assert.equal(checkpoint.artifacts[0]?.sha256, digest);
    // The SHA can be identical but a manifest produced by a different
    // durable transfer UUID is NOT this job's completed publication proof.
    const foreignPath = 'transfer/foreign-operation.bin';
    const foreign = await bridge.begin({ scope, artifactPath: foreignPath,
      repository: input.repository, commitSha: input.commitSha,
      producerOperationId: randomUUID(), size: bytes.length, sha256: digest,
      testStatus: 'unverified', acceptanceStatus: 'pending' });
    for (let offset = 0; offset < bytes.length; offset += 65536) {
      await bridge.putChunk(scope, foreign.sessionId!, offset,
        bytes.subarray(offset, offset + 65536).toString('base64'));
    }
    await bridge.commit(scope, foreign.sessionId!);
    await assert.rejects(adapter.persist({ ...input, artifactPath: foreignPath,
      job: done }), (e:unknown)=>e instanceof ArtifactBridgeError &&
        e.code==='JOB_ARTIFACT_ATTESTATION_MISSING');

    // A plausible local commit ID is not a trusted off-host attestation.
    await assert.rejects(adapter.persist({ ...input,
      job: { ...done, publication: { ...done.publication!,
        durableCommitId: 'f'.repeat(64) } } }),
      (e: unknown) => e instanceof ArtifactBridgeError &&
        e.code === 'JOB_PUBLICATION_COMMIT_MISMATCH');
    await assert.rejects(adapter.persist({ ...input,
      job: { ...done, sha256: 'f'.repeat(64) } }),
      (e: unknown) => e instanceof ArtifactBridgeError &&
        e.code === 'JOB_PUBLICATION_COMMIT_REQUIRED');
    await assert.rejects(adapter.persist({ ...input,
      job: done, scope: { ...scope, accountId: 'foreign-owner' } }),
      (e: unknown) => e instanceof ArtifactBridgeError &&
        e.code === 'JOB_SCOPE_MISMATCH');
    const independent = new ArtifactBridgeStore(path.join(root, 'verified-store'));
    const retrieved = await independent.getCheckpoint(scope, input.workspaceId);
    assert.equal(retrieved?.artifacts[0]?.sha256, digest);
    assert.equal((await adapter.get(scope, input.workspaceId, done))?.artifacts[0]?.sha256,digest);
    // #781 cloned-runbook identity boundary: a distinct transfer UUID with
    // the same owner/device and content must NOT inherit the old checkpoint.
    await assert.rejects(adapter.get(scope,input.workspaceId,
      {...done,id:randomUUID()}),
      (e:unknown)=>e instanceof ArtifactBridgeError &&
        e.code==='JOB_CHECKPOINT_TRANSFER_MISMATCH');
    // A forged/rolled-back local job must not load an old verified checkpoint.
    await assert.rejects(adapter.get(scope,input.workspaceId,
      {...done,state:'MUTATION_UNKNOWN'}),
      (e:unknown)=>e instanceof ArtifactBridgeError && e.code==='JOB_NOT_VERIFIED');
    await assert.rejects(adapter.get(scope,input.workspaceId,
      {...done,publication:{...done.publication!,durableCommitId:'a'.repeat(64)}}),
      (e:unknown)=>e instanceof ArtifactBridgeError &&
        e.code==='JOB_PUBLICATION_COMMIT_MISMATCH');

    grantActive = false;
    await assert.rejects(adapter.get(scope,input.workspaceId,done),
      (e:unknown)=>e instanceof TransferTrustError&&e.code==='CORE_OWNER_REVOKED');
    await assert.rejects(adapter.persist({ ...input, job:done }),
      (e:unknown)=>e instanceof TransferTrustError&&e.code==='CORE_OWNER_REVOKED');
  }));

test('externally revoked lease stops the next bounded native write and never publishes', async () =>
  fixture(async root => {
    const stage = { bytes: Buffer.alloc(0), writes: 0, published: 0 };
    const authority: TrustedTransferAuthority = {
      acquire: async () => ({ epoch: 1, token: 'f'.repeat(64) }),
      assertCurrent: async (_job, proof, phase, offset) => {
        if (proof.epoch !== 1 || (phase === 'WRITE' && offset > 0) ||
            phase === 'PUBLISH') {
          throw new TransferTrustError('STALE_EXTERNAL_FENCE',
            'External authority revoked the old Hub lease.');
        }
      },
    };
    const remote: TransferRemote = {
      ...ops(),
      stat: async (device) => device === args.sourceDeviceId
        ? { type: 'file', size: bytes.length }
        : { type: 'file', size: stage.bytes.length },
      hash: async (device) => device === args.sourceDeviceId
        ? digest : createHash('sha256').update(stage.bytes).digest('hex'),
      read: async (device, _file, offset, size) => {
        const sourceBytes = device === args.sourceDeviceId ? bytes : stage.bytes;
        const chunk = sourceBytes.subarray(offset, offset + size);
        return { sourceBytes: sourceBytes.length, offsetBytes: offset,
          bytesRead: chunk.length, contentBase64: chunk.toString('base64') };
      },
      write: async (_dev, _file, b, first, offset) => {
        const chunk = Buffer.from(b, 'base64');
        if (first) stage.bytes = chunk;
        else if (offset === stage.bytes.length) stage.bytes = Buffer.concat([stage.bytes, chunk]);
        else throw Error('OFFSET_CONFLICT');
        stage.writes++;
        return chunk.length;
      },
      moveNoOverwrite: async () => { stage.published++; },
      writeFenced: async (_job, envelope, encoded, first) => {
        const result = await remote.write(args.targetDeviceId, '/synthetic/stage',
          encoded, first, envelope.offset);
        assert.equal(result, envelope.length);
        return { requestId: envelope.requestId, epoch: envelope.epoch,
          offset: envelope.offset, length: envelope.length, sha256: envelope.sha256 };
      },
      publishFenced: async () => { stage.published++; },
    };
    const grants = { assertCurrent: async () => undefined };
    const jobs = new CrossDeviceTransferJobs(root, remote,
      { requireExternalAuthority: true, authority, grants });
    const started = await jobs.start(args);
    let status: Awaited<ReturnType<typeof jobs.status>> | undefined;
    for (let i = 0; i < 100; i++) {
      status = await jobs.status(started.id, args.accountId,
        args.sourceDeviceId, args.targetDeviceId);
      if (status.state === 'FAILED') break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    await jobs.waitForIdle(started.id);
    assert.equal(status?.state, 'FAILED');
    assert.equal(status.errorCode, 'STALE_EXTERNAL_FENCE');
    assert.equal(stage.writes, 1);
    assert.equal(stage.published, 0);
  }));

test('P0 checkpoint cannot accept local COMPLETED+manifest without external publication CAS',
  async()=>fixture(async root=>{
    const bridge=new ArtifactBridgeStore(path.join(root,'verified-store'));
    const job:TransferJob={...mockJob(),state:'COMPLETED',bytesConfirmed:bytes.length};
    const scope={accountId:job.accountId,projectId:job.projectId,
      deviceId:job.targetDeviceId};
    const artifactPath='transfer/forensic.bin';
    const repository='Naveax/Nexowire',commitSha='a'.repeat(40);
    const session=await bridge.begin({scope,artifactPath,repository,commitSha,
      producerOperationId:job.id,size:bytes.length,sha256:digest,
      testStatus:'unverified',acceptanceStatus:'pending'});
    for(let at=0;at<bytes.length;at+=65_536){
      await bridge.putChunk(scope,session.sessionId!,at,
        bytes.subarray(at,at+65_536).toString('base64'));
    }
    await bridge.commit(scope,session.sessionId!);
    const adapter=new VerifiedTransferCheckpointAdapter(bridge,{
      assertCurrent:async()=>undefined,
    });
    await assert.rejects(adapter.persist({
      scope,job,workspaceId:'no-false-complete',artifactPath,
      repository,commitSha,
    }),(e:unknown)=>e instanceof ArtifactBridgeError &&
      e.code==='JOB_PUBLICATION_COMMIT_REQUIRED');
    assert.equal(await bridge.getCheckpoint(scope,'no-false-complete'),null);
  }));

test('P0: external revoke-start wins protected admission before durable checkpoint write',
  async()=>fixture(async root=>{
    const bridge=new ArtifactBridgeStore(path.join(root,'atomic-gate'));
    const base=mockJob();
    const requestId=randomUUID(), commitId='TEST-MONOTONIC-'+randomUUID();
    const completed:TransferJob={...base,state:'COMPLETED',
      bytesConfirmed:bytes.length,fencing:{epoch:5,token:'f'.repeat(64)},
      publication:{requestId,epoch:5,sha256:digest,dispatched:true,
        durableCommitId:commitId}};
    const scope={accountId:completed.accountId,projectId:completed.projectId,
      deviceId:completed.targetDeviceId};
    const artifactPath='proof/final.bin', repository='Naveax/Nexowire';
    const commitSha='a'.repeat(40);
    const manifest=await bridge.begin({scope,artifactPath,repository,commitSha,
      producerOperationId:completed.id,size:bytes.length,sha256:digest,
      testStatus:'unverified',acceptanceStatus:'pending'});
    for(let offset=0;offset<bytes.length;offset+=65_536) {
      await bridge.putChunk(scope,manifest.sessionId!,offset,
        bytes.subarray(offset,offset+65_536).toString('base64'));
    }
    await bridge.commit(scope,manifest.sessionId!);
    let ownerEpoch=7,writes=0;
    let admitted!:()=>void, release!:()=>void;
    const reached=new Promise<void>(resolve=>{admitted=resolve});
    const released=new Promise<void>(resolve=>{release=resolve});
    class TrackingBridge extends ArtifactBridgeStore {
      override async saveCheckpoint(
        input:Parameters<ArtifactBridgeStore['saveCheckpoint']>[0]) {
        writes++;
        return super.saveCheckpoint(input);
      }
    }
    const store=new TrackingBridge(path.join(root,'atomic-gate'));
    const check=async()=>{
      if(ownerEpoch!==7)throw new TransferTrustError('CORE_GRANT_EPOCH_STALE',
        'Synthetic external owner revoke-start won checkpoint admission.');
    };
    const adapter=new VerifiedTransferCheckpointAdapter(store,{
      assertCurrent:async()=>{await check()}
    },{
      inspect:async()=>({jobId:completed.id,requestId,epoch:5,
        sha256:digest,durableCommitId:commitId}),
      saveIfCurrent:async(_job,write)=>{
        admitted();
        await released;
        // TEST-ONLY protected gate: real off-host provider must serialize
        // revoke-start and the ENTIRE durable fsync/rename operation.
        await check();
        return write();
      },
    });
    const pending=adapter.persist({scope,job:completed,
      workspaceId:'owner-epoch-admission',artifactPath,repository,commitSha});
    try{
      await reached;
      ownerEpoch=8;
    }finally{release()}
    await assert.rejects(pending,(e:unknown)=>
      e instanceof TransferTrustError&&e.code==='CORE_GRANT_EPOCH_STALE');
    assert.equal(writes,0,'revoked external admission may not call Artifact save');
    assert.equal(await bridge.getCheckpoint(scope,'owner-epoch-admission'),null);
  }));
