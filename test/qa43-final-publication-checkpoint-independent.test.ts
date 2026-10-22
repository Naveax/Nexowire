import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ArtifactBridgeStore, ArtifactBridgeError } from '../src/workspace/artifact-bridge.js';
import { VerifiedTransferCheckpointAdapter } from '../src/workspace/artifact-job-checkpoint.js';
import type { TransferJob } from '../src/mcp/cross-device-transfer-jobs.js';
import { TransferTrustError } from '../src/workspace/artifact-job-trust.js';
import { StagingArtifactByteBudget, initArtifactBudgetFixture }
  from '../src/ops/scale-v2-artifact-byte-budget-staging.js';
import { StagingJobBudgetGate } from '../src/workspace/artifact-job-budget-staging.js';

/**
 * #43 independent, test-only checkpoint/publication admission QA.
 * Synthetic Native effects, signer claims, epoch and CAS records below are
 * NOT an off-host trust root, production issuer, or deployed Agent.
 * The original #708, #762 and #776 negative fixtures are not modified.
 */
const bytes = Buffer.alloc(65_536 + 19, 0x43);
const sha = createHash('sha256').update(bytes).digest('hex');
const scope = { accountId: 'owner:qa43', projectId: 'Nexowire', deviceId: 'target-qa43' };
const repository = 'Naveax/Nexowire', commitSha = 'a'.repeat(40);
const artifactPath = 'qa43/publication.bin';
const workspaceId = 'qa43-final-checkpoint';

type Input = Parameters<VerifiedTransferCheckpointAdapter['persist']>[0];
async function temp(fn: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-qa43-'));
  try { await fn(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
function completed(): TransferJob {
  const now = new Date().toISOString();
  return {
    version: 1, id: randomUUID(), accountId: scope.accountId,
    projectId: scope.projectId, sourceDeviceId: 'source-qa43',
    targetDeviceId: scope.deviceId, sourcePath: '/synthetic/source',
    targetPath: '/synthetic/target', stagePath: '/synthetic/stage',
    bytesTotal: bytes.length, bytesConfirmed: bytes.length, sha256: sha,
    state: 'COMPLETED', fencing: { epoch: 11, token: 'f'.repeat(64) },
    publication: { requestId: randomUUID(), epoch: 11, sha256: sha,
      dispatched: true, durableCommitId: 'synthetic-commit-' + randomUUID() },
    createdAt: now, updatedAt: now,
  };
}
async function seeded(root: string) {
  const store = new ArtifactBridgeStore(path.join(root, 'artifact'));
  const job = completed();
  const opened = await store.begin({ scope, artifactPath, repository, commitSha,
    producerOperationId: job.id, size: bytes.length, sha256: sha,
    testStatus: 'unverified', acceptanceStatus: 'pending' });
  for (let at = 0; at < bytes.length; at += 65_536) {
    await store.putChunk(scope, opened.sessionId!, at,
      bytes.subarray(at, at + 65_536).toString('base64'));
  }
  await store.commit(scope, opened.sessionId!);
  const input: Input = { scope, job, workspaceId, artifactPath, repository, commitSha };
  const witness = { jobId: job.id, requestId: job.publication!.requestId,
    epoch: job.publication!.epoch, sha256: sha,
    durableCommitId: job.publication!.durableCommitId! };
  return { store, job, input, witness };
}
function hasCode(code: string) {
  return (e: unknown) => e instanceof ArtifactBridgeError && e.code === code;
}

test('#43: copied job/request/SHA/CAS, foreign issuer or fake signed final ACK cannot mint checkpoint',
  async () => temp(async root => {
    const { store, job, input, witness } = await seeded(root);
    let writes = 0, admissions = 0;
    let issuer = 'trusted-native-issuer';
    const trustedIssuer = issuer;
    class CountedStore extends ArtifactBridgeStore {
      override async saveCheckpoint(arg: Parameters<ArtifactBridgeStore['saveCheckpoint']>[0]) {
        writes++;
        return super.saveCheckpoint(arg);
      }
    }
    const adapter = new VerifiedTransferCheckpointAdapter(
      new CountedStore(path.join(root, 'artifact')),
      { assertCurrent: async () => undefined },
      {
        // Independent test oracle: a caller-controlled final HMAC/ACK does not
        // create an external commit; issuer identity is checked by the oracle.
        inspect: async j => issuer === trustedIssuer && j.id === witness.jobId
          ? witness : null,
        saveIfCurrent: async (_job, write) => {
          admissions++;
          return write();
        },
      });
    // Correct-looking test HMAC from an attacker-controlled signer is not
    // evidence of an externally committed original Native publication.
    const untrustedKey = randomBytes(32);
    const forgedClaims = {
      requestId: job.publication!.requestId, jobId: job.id,
      accountId: job.accountId, projectId: job.projectId,
      targetDeviceId: job.targetDeviceId, targetPath: job.targetPath,
      bytesTotal: job.bytesTotal, sha256: job.sha256, epoch: job.fencing!.epoch,
    };
    const forgedFinalReceipt = { ...forgedClaims,
      proof: createHmac('sha256', untrustedKey)
        .update(JSON.stringify(forgedClaims)).digest('hex') };
    assert.match(forgedFinalReceipt.proof, /^[0-9a-f]{64}$/);
    const bad: Array<{ label: string; job: TransferJob; code: string }> = [
      { label: 'cloned jobId', job: { ...job, id: randomUUID() },
        code: 'JOB_PUBLICATION_COMMIT_MISMATCH' },
      { label: 'forged requestId',
        job: { ...job, publication: { ...job.publication!, requestId: randomUUID() } },
        code: 'JOB_PUBLICATION_COMMIT_MISMATCH' },
      { label: 'copied durableCommitId with another claim',
        job: { ...job, publication: { ...job.publication!,
          durableCommitId: 'synthetic-commit-' + randomUUID() } },
        code: 'JOB_PUBLICATION_COMMIT_MISMATCH' },
      { label: 'changed lease epoch',
        job: { ...job, fencing: { epoch: 12, token: 'f'.repeat(64) },
          publication: { ...job.publication!, epoch: 12 } },
        code: 'JOB_PUBLICATION_COMMIT_MISMATCH' },
      { label: 'changed entire published SHA',
        job: { ...job, sha256: 'b'.repeat(64),
          publication: { ...job.publication!, sha256: 'b'.repeat(64) } },
        code: 'JOB_PUBLICATION_COMMIT_MISMATCH' },
      { label: 'signed final ACK but lost external commit',
        job: Object.assign(
          { ...job, publication: { ...job.publication!, durableCommitId: undefined } },
          { forgedFinalReceipt }),
        code: 'JOB_PUBLICATION_COMMIT_REQUIRED' },
      { label: 'lost Native final ACK is UNKNOWN even if bytes were written',
        job: { ...job, state: 'MUTATION_UNKNOWN', errorCode: 'FINAL_RECEIPT_MISMATCH' },
        code: 'JOB_NOT_VERIFIED' },
    ];
    for (const item of bad) {
      await assert.rejects(adapter.persist({ ...input, job: item.job }),
        hasCode(item.code), item.label);
      assert.equal(await store.getCheckpoint(scope, workspaceId), null, item.label);
    }
    issuer = 'synthetic-foreign-issuer';
    await assert.rejects(adapter.persist(input),
      hasCode('JOB_PUBLICATION_COMMIT_MISMATCH'),
      'signed final receipt from untrusted issuer is NOT publication CAS');
    assert.equal(writes, 0, 'forged evidence may not reach durable checkpoint write');
    assert.equal(admissions, 0, 'forged evidence may not reach admission callback');
  }));

test('#43: two Hub readers cannot observe checkpoint after revoke wins before saveIfCurrent',
  async () => temp(async root => {
    const { store, input, witness, job } = await seeded(root);
    const independentReader = new ArtifactBridgeStore(path.join(root, 'artifact'));
    let ownerEpoch = 19, saveCalls = 0;
    let entered!: () => void, release!: () => void;
    const atAdmission = new Promise<void>(r => { entered = r; });
    const continueAdmission = new Promise<void>(r => { release = r; });
    const current = async () => {
      if (ownerEpoch !== 19)
        throw new TransferTrustError('CORE_GRANT_EPOCH_STALE',
          'Synthetic owner revoked before checkpoint admission');
    };
    class CountedStore extends ArtifactBridgeStore {
      override async saveCheckpoint(arg: Parameters<ArtifactBridgeStore['saveCheckpoint']>[0]) {
        saveCalls++;
        return super.saveCheckpoint(arg);
      }
    }
    const adapterA = new VerifiedTransferCheckpointAdapter(
      new CountedStore(path.join(root, 'artifact')),
      { assertCurrent: async () => current() }, {
        inspect: async () => witness,
        saveIfCurrent: async (_j, write) => {
          entered();
          await continueAdmission;
          await current(); // test-only admission, NOT off-host CAS
          return write();
        },
      });
    const adapterB = new VerifiedTransferCheckpointAdapter(
      independentReader, { assertCurrent: async () => current() },
      { inspect: async () => witness });
    const pending = adapterA.persist(input);
    try {
      await atAdmission;
      assert.equal(await independentReader.getCheckpoint(scope, workspaceId), null,
        'not visible before protected admission');
      ownerEpoch = 20; // Hub B starts revocation
      await assert.rejects(adapterB.persist(input),
        (e: unknown) => e instanceof TransferTrustError &&
          e.code === 'CORE_GRANT_EPOCH_STALE');
      release();
      await assert.rejects(pending,
        (e: unknown) => e instanceof TransferTrustError &&
          e.code === 'CORE_GRANT_EPOCH_STALE');
      assert.equal(saveCalls, 0);
      assert.equal(await store.getCheckpoint(scope, workspaceId), null);
      assert.equal(await independentReader.getCheckpoint(scope, workspaceId), null);
      await assert.rejects(adapterB.get(scope, workspaceId, job),
        (e: unknown) => e instanceof TransferTrustError &&
          e.code === 'CORE_GRANT_EPOCH_STALE');
    } finally {
      release();
      await pending.catch(() => undefined);
    }
  }));

test('#43: concurrent/reentrant admission must not dispatch a second durable checkpoint save',
  async () => temp(async root => {
    const { input, witness } = await seeded(root);
    let durableWrites = 0;
    class CountedStore extends ArtifactBridgeStore {
      override async saveCheckpoint(arg: Parameters<ArtifactBridgeStore['saveCheckpoint']>[0]) {
        durableWrites++;
        return super.saveCheckpoint(arg);
      }
    }
    const adapter = new VerifiedTransferCheckpointAdapter(
      new CountedStore(path.join(root, 'artifact')),
      { assertCurrent: async () => undefined },
      {
        inspect: async () => witness,
        // Hostile provider violates single-use callback semantics by invoking
        // two writes concurrently. A source-local guard must not *dispatch*
        // both. This is a guard regression, NOT real off-host CAS validation.
        saveIfCurrent: async (_job, write) => {
          const first = write(), second = write();
          const both = await Promise.allSettled([first, second]);
          const rejected = both.find(x => x.status === 'rejected');
          if (rejected?.status === 'rejected') throw rejected.reason;
          if (both[0]?.status !== 'fulfilled')
            throw Error('FIRST_SAVE_DID_NOT_COMPLETE');
          return both[0].value;
        },
      });
    await assert.rejects(adapter.persist(input),
      (e: unknown) => e instanceof ArtifactBridgeError &&
        e.code === 'JOB_CHECKPOINT_WRITE_REPLAY',
      'second invocation should be rejected deterministically');
    assert.equal(durableWrites, 1,
      'reentrant protected callback may invoke physical save at most once');
  }));

test('#43: quota cancellation never releases reserved bytes until BOTH trusted writer stop and deletion',
  async () => temp(async root => {
    const db = new DatabaseSync(path.join(root, 'budget.sqlite'));
    try {
      db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;');
      initArtifactBudgetFixture(db);
      const budget = new StagingArtifactByteBudget(db);
      const job = { ...completed(), bytesConfirmed: 0 };
      const now = () => new Date('2026-10-23T00:00:00Z');
      const noAttestation = new StagingJobBudgetGate(budget,
        async () => 8 * 1024 ** 3, now);
      await noAttestation.reserve(job);
      await noAttestation.cancel(job);
      await assert.rejects(noAttestation.acknowledgeVerifiedDeletion(job),
        /TRUSTED_WRITER_DELETION_UNAVAILABLE/);
      // Deliberately invalid untrusted response: the type interface cannot
      // create trustworthy OS writer-stop evidence.
      const partial = new StagingJobBudgetGate(budget,
        async () => 8 * 1024 ** 3, now, {
          attest: async () => ({ durableDeletionVerified: true,
            writersStoppedVerified: false } as never),
        });
      await assert.rejects(partial.acknowledgeVerifiedDeletion(job),
        /WRITER_FENCE_REQUIRED/);
      const pending = db.prepare('SELECT state FROM budget_artifact_sessions').get() as { state: string };
      assert.equal(pending.state, 'CANCEL_PENDING',
        'lost ACK or revoke must retain escrow until verified writer stop');
      await assert.rejects(noAttestation.reserve(job),
        /BUDGET_FAIL_CLOSED_DENIED_STATE/);
      const verified = new StagingJobBudgetGate(budget,
        async () => 8 * 1024 ** 3, now, {
          attest: async () => ({
            durableDeletionVerified: true, writersStoppedVerified: true,
          }),
        });
      await verified.acknowledgeVerifiedDeletion(job);
      const released = db.prepare('SELECT state FROM budget_artifact_sessions').get() as { state: string };
      assert.equal(released.state, 'RELEASED',
        'this positive fixture is synthetic; no physical writer was stopped');
    } finally { db.close(); }
  }));
