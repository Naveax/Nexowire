import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AuthenticatedTransferRoute, TransferBinding, TransferCheckpoint }
  from '../src/mcp/cross-device-transfer-continuity.js';
import {
  inspectOneCallWorkerConnectionJournal,
  type FencedWorkerJournalSnapshot,
} from '../src/mcp/cross-device-worker-journal-link.js';

/**
 * #21 negative for the existing #770 read-only observer, scoped to #780's
 * future checkpoint/resume safety contract. This is NOT a coding-agent
 * checkpoint implementation and does NOT attest a protected Broker/Agent.
 */
const data = Buffer.alloc(65_536, 0x4a);
const sha = createHash('sha256').update(data).digest('hex');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
async function durable(pathname: string, value: unknown) {
  const f = await fs.open(pathname, 'w', 0o600);
  try { await f.writeFile(JSON.stringify(value)); await f.sync(); }
  finally { await f.close(); }
}
async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nw-21-unknown-checkpoint-'));
  try { await run(dir); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}
function rows() {
  const id = randomUUID(), pendingId = randomUUID();
  const binding: TransferBinding = {
    jobId: id, ownerId: 'owner-qa21', projectId: 'Nexowire',
    sourceDeviceId: 'source-qa21', destinationDeviceId: 'target-qa21',
    sourcePath: '/synthetic/source', targetPath: '/synthetic/target',
    stagePath: '/synthetic/target.part', sourceSha256: sha,
    totalBytes: data.length,
  };
  const worker: FencedWorkerJournalSnapshot = {
    id, accountId: binding.ownerId, projectId: binding.projectId,
    sourceDeviceId: binding.sourceDeviceId,
    targetDeviceId: binding.destinationDeviceId,
    sourcePath: binding.sourcePath, targetPath: binding.targetPath,
    stagePath: binding.stagePath, bytesTotal: data.length,
    bytesConfirmed: 0, sha256: sha, state: 'MUTATION_UNKNOWN',
    errorCode: 'FORGED_WRITE_RECEIPT',
    fencing: { epoch: 27, token: 'fixture-synthetic-lease-' + randomUUID() },
    pending: {
      requestId: pendingId, epoch: 27, offset: 0, length: data.length,
      sha256: sha, dispatched: true,
    },
  };
  const checkpoint: TransferCheckpoint = {
    binding, revision: 10, epoch: 5, offset: 0, status: 'unknown',
    pending: {
      requestId: pendingId, epoch: 5, offset: 0, length: data.length,
      sha256: sha, ackObserved: false,
    },
  };
  const route: AuthenticatedTransferRoute = {
    ownerId: binding.ownerId, projectId: binding.projectId,
    sourceDeviceId: binding.sourceDeviceId,
    destinationDeviceId: binding.destinationDeviceId, epoch: 5,
  };
  return { worker, checkpoint, route };
}
test('#780 QA: restored forged Native ACK keeps original errorCode, UNKNOWN and pending through read-only reconcile',
  { timeout: 10_000 }, async () => fixture(async dir => {
    const file = path.join(dir, 'worker-connection-snapshot.json');
    await durable(file, rows());
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as ReturnType<typeof rows>;
    const pristine = JSON.stringify(saved);
    let readbacks = 0, checked = 0;
    const inspect = () => inspectOneCallWorkerConnectionJournal({
      ...saved,
      authorize: async () => true,
      workerLease: { check: async () => true },
      ownerAdmission: {
        ownerEpoch: 71, grantGeneration: 9,
        deviceEpoch: randomUUID(), sessionEpoch: randomUUID(), privilege: 'CORE' as const,
      },
      ownerEpochWitness: { assertFresh: async challenge => {
        checked++;
        return challenge.ownerId === saved.worker.accountId &&
          challenge.deviceId === saved.worker.targetDeviceId &&
          challenge.ownerEpoch === 71 && challenge.grantGeneration === 9 &&
          /^[0-9a-f]{64}$/.test(challenge.challengeNonce);
      } },
      sessionWitness: { currentEpoch: async () => saved.route.epoch },
      stageReadback: { inspect: async (worker, pending) => {
        readbacks++;
        return { kind: 'verified' as const, deviceId: worker.targetDeviceId,
          offset: pending.offset, length: pending.length, sha256: pending.sha256 };
      } },
    });
    for (let i = 0; i < 3; i++) {
      const out = await inspect();
      assert.equal(out.state, 'readback_verified_not_committed');
      assert.equal(out.requestId, saved.worker.pending?.requestId);
      assert.equal(out.automaticallyReplayable, false);
      assert.equal(out.checkpointAdvanced, false);
      assert.equal(out.externalSideEffectProven, false);
      assert.equal(out.mutationExecuted, false);
      assert.equal(saved.worker.state, 'MUTATION_UNKNOWN');
      assert.equal(saved.worker.errorCode, 'FORGED_WRITE_RECEIPT');
      assert.equal(saved.worker.pending?.dispatched, true);
      assert.equal(saved.worker.pending?.requestId, saved.checkpoint.pending?.requestId);
      assert.equal(saved.checkpoint.status, 'unknown');
      assert.equal(saved.checkpoint.pending?.ackObserved, false);
      assert.equal(JSON.stringify(saved), pristine);
    }
    assert.equal(readbacks, 3);
    assert.equal(checked, 6, 'each read requires fresh owner witness before and after readback');
    assert.equal(await fs.readFile(file, 'utf8'), pristine,
      'read-only reconciliation must not overwrite the durable forensic journal');
  }));

test('#780 QA: restored UNKNOWN final publication retains original diagnostic even with plausible final receipt',
  { timeout: 10_000 }, async () => fixture(async dir => {
    const initial = rows();
    initial.worker.pending = undefined;
    initial.worker.bytesConfirmed = data.length;
    initial.worker.errorCode = 'FINAL_RECEIPT_UNAUTHENTICATED';
    initial.worker.publication = {
      requestId: randomUUID(), epoch: 27, sha256: sha, dispatched: true,
    };
    initial.checkpoint.pending = undefined;
    initial.checkpoint.offset = data.length;
    initial.checkpoint.status = 'unknown';
    const file = path.join(dir, 'orphan-publication.json');
    await durable(file, initial);
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as typeof initial;
    const original = JSON.stringify(saved);
    let receipts = 0, targets = 0;
    for (const allow of [true, false]) {
      const out = await inspectOneCallWorkerConnectionJournal({
        ...saved,
        authorize: async () => allow,
        workerLease: { check: async () => true },
        ownerAdmission: {
          ownerEpoch: 17, grantGeneration: 4,
          deviceEpoch: randomUUID(), sessionEpoch: randomUUID(), privilege: 'CORE',
        },
        ownerEpochWitness: { assertFresh: async () => allow },
        sessionWitness: { currentEpoch: async () => saved.route.epoch },
        publicationReceiptReadback: { inspect: async worker => {
          receipts++;
          return { kind: 'verified' as const, receipt: {
            requestId: worker.publication!.requestId, jobId: worker.id,
            accountId: worker.accountId, projectId: worker.projectId,
            targetDeviceId: worker.targetDeviceId, targetPath: worker.targetPath,
            bytesTotal: worker.bytesTotal, sha256: worker.sha256,
            epoch: worker.publication!.epoch, proof: 'synthetic-no-real-signature',
          } };
        } },
        publishedTargetReadback: { inspect: async worker => {
          targets++;
          return { kind: 'verified' as const, deviceId: worker.targetDeviceId,
            targetPath: worker.targetPath, bytesTotal: worker.bytesTotal, sha256: worker.sha256 };
        } },
      });
      assert.equal(out.state, allow ? 'mutation_unknown' : 'authority_blocked');
      assert.equal(out.automaticallyReplayable, false);
      assert.equal(out.checkpointAdvanced, false);
      assert.equal(out.externalSideEffectProven, false);
      assert.equal(saved.worker.errorCode, 'FINAL_RECEIPT_UNAUTHENTICATED');
      assert.equal(saved.worker.state, 'MUTATION_UNKNOWN');
      assert.equal(saved.worker.publication?.dispatched, true);
      assert.equal(saved.checkpoint.status, 'unknown');
      assert.equal(JSON.stringify(saved), original);
    }
    assert.equal(receipts, 0, 'UNKNOWN must not be rehabilitated by old signed-looking receipt');
    assert.equal(targets, 0);
    assert.equal(await fs.readFile(file, 'utf8'), original);
  }));
