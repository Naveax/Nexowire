/**
 * #47 deterministic two-Hub publication/revoke HOSTILE QA, source-only.
 *
 * All "external" state is a TEST MODEL sharing one JS process.
 * Its locks, epochs, and receipts are NOT rollback-independent CAS,
 * an authenticated Native signer, or production authority. No live effects.
 *
 * Cross-review: #18 PR #781 cloned UNKNOWN; #22 PR #708 unchanged RED
 * checkpoint save TOCTOU; #35 pairing/enrollment contract is not shipped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TransferJob } from '../src/mcp/cross-device-transfer-jobs.js';
import { ArtifactBridgeStore, ArtifactBridgeError, type ArtifactCheckpoint } from '../src/workspace/artifact-bridge.js';
import {
  VerifiedTransferCheckpointAdapter,
  type TrustedCheckpointPublicationReadback,
} from '../src/workspace/artifact-job-checkpoint.js';
import {
  TransferTrustError, type TrustedTransferCoreGrants,
  type TrustedPublicationCommit,
} from '../src/workspace/artifact-job-trust.js';

const payload = Buffer.from('NEXOWIRE-QA47-disposable-immutable-payload');
const digest = createHash('sha256').update(payload).digest('hex');
const repository = 'Naveax/Nexowire';
const commitSha = 'a'.repeat(40);
const artifactPath = 'qa47/transfer.bin';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = () => resolve(); });
  return { promise, release };
}

async function isolated(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-qa47-'));
  try { await fn(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

function completed(): TransferJob {
  const now = new Date().toISOString();
  return {
    version: 1, id: randomUUID(),
    accountId: 'qa47:synthetic-owner', projectId: 'Nexowire',
    sourceDeviceId: 'qa47-source', targetDeviceId: 'qa47-target',
    sourcePath: '/synthetic/source', targetPath: '/synthetic/target',
    stagePath: '/synthetic/stage', bytesTotal: payload.length,
    bytesConfirmed: payload.length, sha256: digest,
    state: 'COMPLETED', createdAt: now, updatedAt: now,
    fencing: { epoch: 5, token: 'f'.repeat(64) },
    publication: {
      requestId: randomUUID(), epoch: 5, sha256: digest,
      dispatched: true, durableCommitId: 'QA47-MODEL-ONLY-' + randomUUID(),
    },
  };
}

async function seeded(root: string, job: TransferJob) {
  const storeRoot = path.join(root, 'disposable-artifacts');
  const store = new ArtifactBridgeStore(storeRoot);
  const scope = {
    accountId: job.accountId, projectId: job.projectId,
    deviceId: job.targetDeviceId,
  };
  const started = await store.begin({
    scope, artifactPath, repository, commitSha,
    producerOperationId: job.id, size: payload.length, sha256: digest,
    testStatus: 'unverified', acceptanceStatus: 'pending',
  });
  await store.putChunk(scope, started.sessionId!, 0, payload.toString('base64'));
  await store.commit(scope, started.sessionId!);
  const input = {
    scope, job, workspaceId: 'qa47-exact-publication',
    artifactPath, repository, commitSha,
  };
  return { store, storeRoot, input, scope };
}

function hasCode(code: string) {
  return (err: unknown): boolean =>
    err instanceof Error && 'code' in err && err.code === code;
}

/** A deterministic *model*, deliberately not a CAS provider implementation.
 * Logical identity is tracked OUTSIDE TransferJob precisely because the
 * current TransferJob / TrustedPublicationCommit contract omits it.
 */
class AuthorityModel {
  ownerEpoch = 7;
  grantGeneration = 3;
  readonly issuerEpoch = 11;
  readonly logicalMutationId = randomUUID();
  revokeStarted = false;
  saved = 0;
  ackLost = false;
  beforeAdmission?: () => Promise<void>;
  private activeWrite?: ReturnType<typeof barrier>;
  private readonly binding: {
    jobId: string; requestId: string; sha256: string; epoch: number;
    durableCommitId: string; accountId: string; targetDeviceId: string;
  };
  private readonly proof: TrustedPublicationCommit;

  constructor(job: TransferJob) {
    assert.ok(job.publication);
    assert.ok(job.fencing);
    this.binding = {
      jobId: job.id, requestId: job.publication.requestId,
      sha256: job.sha256, epoch: job.fencing.epoch,
      durableCommitId: job.publication.durableCommitId!,
      accountId: job.accountId, targetDeviceId: job.targetDeviceId,
    };
    this.proof = {
      jobId: job.id, requestId: job.publication.requestId,
      sha256: job.sha256, epoch: job.fencing.epoch,
      durableCommitId: job.publication.durableCommitId!,
    };
  }

  private check(job: Readonly<TransferJob>) {
    if (this.ownerEpoch !== 7 || this.grantGeneration !== 3 || this.revokeStarted) {
      throw new TransferTrustError('CORE_GRANT_EPOCH_STALE',
        'MODEL: revoke-start or new owner/grant epoch blocks old identity.');
    }
    if (job.id !== this.binding.jobId ||
        job.accountId !== this.binding.accountId ||
        job.targetDeviceId !== this.binding.targetDeviceId ||
        job.sha256 !== this.binding.sha256 ||
        job.fencing?.epoch !== this.binding.epoch ||
        job.publication?.requestId !== this.binding.requestId ||
        job.publication?.durableCommitId !== this.binding.durableCommitId ||
        job.publication?.sha256 !== this.binding.sha256) {
      throw new TransferTrustError('QA47_MODEL_IDENTITY_STALE',
        'MODEL: cloned job/request/owner/device did not match immutable CAS identity.');
    }
  }

  readonly grants: TrustedTransferCoreGrants = {
    assertCurrent: async job => { this.check(job); },
  };

  readonly readback: TrustedCheckpointPublicationReadback = {
    inspect: async job => {
      this.check(job);
      return { ...this.proof };
    },
    saveIfCurrent: async (job, save): Promise<ArtifactCheckpoint> => {
      // This pause simulates the real #708 readback-to-admission gap.
      await this.beforeAdmission?.();
      this.check(job);
      if (this.activeWrite) {
        throw new TransferTrustError('QA47_MODEL_CONCURRENT_WRITE',
          'MODEL: a second Hub cannot enter an already admitted write.');
      }
      const active = barrier();
      this.activeWrite = active;
      try {
        const checkpoint = await save();
        this.saved++;
        if (this.ackLost) {
          throw new TransferTrustError('QA47_MODEL_LOST_ACK',
            'MODEL: save may be durable but the response disappeared.');
        }
        return checkpoint;
      } finally {
        this.activeWrite = undefined;
        active.release();
      }
    },
  };

  /** Revoke-start fences new admissions. A previously admitted durable save
   * finishes BEFORE the simulated revoke linearization. Local-only ordering.
   */
  async revoke(): Promise<void> {
    this.revokeStarted = true;
    const active = this.activeWrite;
    if (active) await active.promise;
    this.ownerEpoch++;
    this.grantGeneration++;
  }

  rePairWithoutChangingOwnerEpoch() {
    this.grantGeneration++;
  }
}

test('#47: valid publication readback without protected saveIfCurrent fails closed before write', async () =>
  isolated(async root => {
    const job = completed();
    const { store, input, scope } = await seeded(root, job);
    const model = new AuthorityModel(job);
    const hub = new VerifiedTransferCheckpointAdapter(store, model.grants, {
      inspect: model.readback.inspect,
    });
    await assert.rejects(hub.persist(input), hasCode('JOB_CHECKPOINT_ATOMIC_ADMISSION_REQUIRED'));
    assert.equal(await store.getCheckpoint(scope, input.workspaceId), null);
    assert.equal(model.saved, 0);
  }));

test('#47: Hub B revoke-start wins AFTER Hub A readbacks but BEFORE atomic save admission', async () =>
  isolated(async root => {
    const job = completed();
    const { store, input, scope } = await seeded(root, job);
    const model = new AuthorityModel(job);
    const atAdmission = barrier(), resumeAdmission = barrier();
    model.beforeAdmission = async () => {
      atAdmission.release();
      await resumeAdmission.promise;
    };
    const hubA = new VerifiedTransferCheckpointAdapter(store, model.grants, model.readback);
    const pending = hubA.persist(input);
    try {
      await atAdmission.promise;
      // Distinct "Hub B" shares a modelled owner authority, not a process mutex.
      await model.revoke();
    } finally {
      resumeAdmission.release();
    }
    await assert.rejects(pending, hasCode('CORE_GRANT_EPOCH_STALE'));
    assert.equal(model.saved, 0);
    assert.equal(await store.getCheckpoint(scope, input.workspaceId), null);
  }));

test('#47: admitted save linearizes BEFORE concurrent revoke; old Hub cannot later read checkpoint', async () =>
  isolated(async root => {
    const job = completed();
    const { storeRoot, input, scope } = await seeded(root, job);
    const model = new AuthorityModel(job);
    const reachedSave = barrier(), releaseSave = barrier();
    class ParkedStore extends ArtifactBridgeStore {
      override async saveCheckpoint(args: Parameters<ArtifactBridgeStore['saveCheckpoint']>[0]) {
        reachedSave.release();
        await releaseSave.promise;
        return super.saveCheckpoint(args);
      }
    }
    const store = new ParkedStore(storeRoot);
    const hubA = new VerifiedTransferCheckpointAdapter(store, model.grants, model.readback);
    const hubB = new VerifiedTransferCheckpointAdapter(store, model.grants, model.readback);
    const pending = hubA.persist(input);
    await reachedSave.promise;
    // Must not cross the revoke linearization while the admitted save remains in flight.
    const revoking = model.revoke();
    try {
      assert.equal(await store.getCheckpoint(scope, input.workspaceId), null);
    } finally {
      releaseSave.release();
    }
    const checkpoint = await pending;
    await revoking;
    assert.equal(checkpoint.workspaceId, input.workspaceId);
    assert.equal(model.saved, 1);
    assert.ok(await store.getCheckpoint(scope, input.workspaceId));
    await assert.rejects(hubB.get(scope, input.workspaceId, job), hasCode('CORE_GRANT_EPOCH_STALE'));
  }));

test('#47: cloned UNKNOWN job with borrowed signed-final-looking publication is not independently committed', async () =>
  isolated(async root => {
    const job = completed();
    const { store, input, scope } = await seeded(root, job);
    const model = new AuthorityModel(job);
    const hubB = new VerifiedTransferCheckpointAdapter(store, model.grants, model.readback);
    const unknown: TransferJob = {
      ...job, state: 'MUTATION_UNKNOWN', bytesConfirmed: payload.length,
      errorCode: 'FINAL_RECEIPT_MISMATCH',
      publication: { ...job.publication!, durableCommitId: undefined },
    };
    const unchanged = JSON.stringify(unknown);
    const clone: TransferJob = {
      ...unknown, id: randomUUID(), state: 'COMPLETED',
      publication: { ...job.publication! },
    };
    await assert.rejects(hubB.persist({ ...input, job: clone }), hasCode('QA47_MODEL_IDENTITY_STALE'));
    assert.equal(await store.getCheckpoint(scope, input.workspaceId), null);
    assert.equal(JSON.stringify(unknown), unchanged);
    assert.equal(model.saved, 0);
  }));

test('#47: grantGeneration re-pair denies old checkpoint even with unchanged ownerEpoch', async () =>
  isolated(async root => {
    const job = completed();
    const { store, input, scope } = await seeded(root, job);
    const model = new AuthorityModel(job);
    const hub = new VerifiedTransferCheckpointAdapter(store, model.grants, model.readback);
    model.rePairWithoutChangingOwnerEpoch();
    assert.equal(model.ownerEpoch, 7);
    await assert.rejects(hub.persist(input), hasCode('CORE_GRANT_EPOCH_STALE'));
    assert.equal(await store.getCheckpoint(scope, input.workspaceId), null);
  }));

test('#47: lost save ACK means UNKNOWN visibility, never a verified second dispatch', async () =>
  isolated(async root => {
    const job = completed();
    const { store, input, scope } = await seeded(root, job);
    const model = new AuthorityModel(job);
    model.ackLost = true;
    const hub = new VerifiedTransferCheckpointAdapter(store, model.grants, model.readback);
    await assert.rejects(hub.persist(input), hasCode('QA47_MODEL_LOST_ACK'));
    assert.equal(model.saved, 1);
    // Raw store contains a checkpoint. This is NOT a successfully acknowledged
    // publication, and is exactly why the caller must reconcile rather than replay.
    assert.ok(await store.getCheckpoint(scope, input.workspaceId));
    const unknown: TransferJob = { ...job, state: 'MUTATION_UNKNOWN' };
    await assert.rejects(hub.get(scope, input.workspaceId, unknown), hasCode('JOB_NOT_VERIFIED'));
    // No Native writers exist in this test: no assertion of a physical writer-stop.
  }));

test('#47 CONTRACT GAP: TransferJob and publication receipt lack immutable logicalMutationId / ownerEpoch / grantGeneration', () => {
  const job = completed();
  const model = new AuthorityModel(job);
  assert.ok(model.logicalMutationId);
  assert.equal('logicalMutationId' in job, false);
  assert.equal('ownerEpoch' in job, false);
  assert.equal('grantGeneration' in job, false);
  assert.equal('logicalMutationId' in model.readback, false);
  // PASS here means missing fields are CONFIRMED, not that their authority
  // binding is implemented. No synthetic PASS may release #587/#588.
});

test('#47: fake provider response without executing callback cannot invent a checkpoint', async () =>
  isolated(async root => {
    const job = completed();
    const { store, input, scope } = await seeded(root, job);
    const model = new AuthorityModel(job);
    const bogus = new VerifiedTransferCheckpointAdapter(store, model.grants, {
      inspect: model.readback.inspect,
      saveIfCurrent: async () => ({
        version: 1, scope, workspaceId: input.workspaceId, repository,
        commitSha, summary: '', completed: [], remaining: [], lastCommands: [],
        artifacts: [], updatedAt: new Date().toISOString(),
      } as ArtifactCheckpoint),
    });
    await assert.rejects(bogus.persist(input), hasCode('JOB_CHECKPOINT_ATOMIC_ADMISSION_INVALID'));
    assert.equal(await store.getCheckpoint(scope, input.workspaceId), null);
  }));


/**
 * #47 NEXT2 intentionally RED SOURCE negative, distinct from #22/#708:
 * a trusted-admission adapter must invoke the write callback at most once
 * even when its provider accidentally calls it concurrently while the first
 * checkpoint write is unresolved. The source currently checks "committed"
 * AFTER awaiting saveCheckpoint, so both invocations can enter the write.
 *
 * This is a source callback contract defect, not independent external CAS
 * or a two-device/rollback security proof. The deliberately adversarial
 * provider below is NOT eligible for production installation.
 */
test('#47 NEXT2 RED: concurrent saveIfCurrent callbacks must not enter two durable checkpoint writes', async () =>
  isolated(async root => {
    const job = completed();
    const { storeRoot, input, scope } = await seeded(root, job);
    const model = new AuthorityModel(job);
    const enteredFirstSave = barrier();
    const releaseFirstSave = barrier();
    let writeEntries = 0;
    class CountingBridge extends ArtifactBridgeStore {
      override async saveCheckpoint(args: Parameters<ArtifactBridgeStore['saveCheckpoint']>[0]) {
        writeEntries++;
        if (writeEntries === 1) {
          enteredFirstSave.release();
          await releaseFirstSave.promise;
        }
        return super.saveCheckpoint(args);
      }
    }
    const store = new CountingBridge(storeRoot);
    const hostileProvider: TrustedCheckpointPublicationReadback = {
      inspect: model.readback.inspect,
      saveIfCurrent: async (_job, save) => {
        const first = save();
        try {
          await enteredFirstSave.promise;
          // Invoke again before the first callback resolves. This is NOT a
          // mock claiming atomic CAS; it is an intentionally broken caller.
          const second = save();
          releaseFirstSave.release();
          const [a, b] = await Promise.allSettled([first, second]);
          if (a.status === 'rejected') throw a.reason;
          // Observe the second even if the adapter correctly rejects it.
          if (b.status === 'fulfilled') {
            assert.equal(writeEntries, 1,
              'A second provider callback must never reach the durable ArtifactBridge writer');
          }
          return a.value;
        } finally {
          releaseFirstSave.release();
        }
      },
    };
    const hubA = new VerifiedTransferCheckpointAdapter(store, model.grants, hostileProvider);
    const outcome = await hubA.persist(input).then(
      () => 'ACKNOWLEDGED',
      (error: unknown) => error instanceof Error && 'code' in error
        ? String(error.code) : 'UNKNOWN_ERROR',
    );
    assert.equal(writeEntries, 1,
      'REPRODUCED P0 SOURCE GAP: concurrent callback invocations entered ArtifactBridge.saveCheckpoint twice before committed was set');
    assert.ok(await store.getCheckpoint(scope, input.workspaceId),
      'At most one independently tracked local checkpoint can be left by this fixture');
    assert.ok(outcome === 'ACKNOWLEDGED' ||
      outcome === 'JOB_CHECKPOINT_WRITE_REPLAY' ||
      outcome === 'JOB_CHECKPOINT_ATOMIC_ADMISSION_INVALID',
      'Outcome must be explicit, never trusted as native publication or retry permission');
  }));
