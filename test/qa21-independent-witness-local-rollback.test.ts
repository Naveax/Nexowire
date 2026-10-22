import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AuthenticatedTransferRoute, TransferBinding, TransferCheckpoint }
  from '../src/mcp/cross-device-transfer-continuity.js';
import {
  inspectOneCallWorkerConnectionJournal,
  type BrokerOwnerEpochAdmission,
  type BrokerOwnerEpochChallenge,
  type BrokerOwnerEpochWitness,
  type FencedWorkerJournalSnapshot,
} from '../src/mcp/cross-device-worker-journal-link.js';

/**
 * #21 negative cross-review of #708 stale two-Hub publish and #742 orphan
 * reconnect. This HMAC fixture represents an INDEPENDENT, read-only,
 * durable witness boundary; it is NOT real Broker signing, real external CAS
 * or a production trust root. No live Hub/Agent/network or destination writes.
 */
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type PersistedEpoch = BrokerOwnerEpochAdmission & { ownerId: string; deviceId: string };
type SignedResponse = { challenge: BrokerOwnerEpochChallenge; mac: string };
const wire = (c: BrokerOwnerEpochChallenge) => JSON.stringify([
  c.ownerId, c.deviceId, c.ownerEpoch, c.grantGeneration,
  c.deviceEpoch, c.sessionEpoch, c.privilege, c.challengeNonce,
]);

async function fsyncJson(filename: string, value: unknown) {
  const fd = await fs.open(filename, 'w', 0o600);
  try {
    await fd.writeFile(JSON.stringify(value));
    await fd.sync();
  } finally {
    await fd.close();
  }
}

test('#21 external durable witness: rolled-back local journals and OLD valid HMAC cannot attest fresh owner epoch',
  { timeout: 15_000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nex-21-independent-witness-'));
    try {
      const local = path.join(root, 'rollbackable-local');
      const external = path.join(root, 'synthetic-external-witness');
      await fs.mkdir(local);
      await fs.mkdir(external);
      const localFile = path.join(local, 'snapshot.json');
      const externalFile = path.join(external, 'monotonic.json');
      const signerKey = randomBytes(32); // never written to the local journal
      const content = Buffer.alloc(65_536, 0x45);
      const sha256 = digest(content);
      const id = randomUUID();
      const requestId = randomUUID();
      const binding: TransferBinding = {
        jobId: id, ownerId: 'owner-21', projectId: 'Nexowire',
        sourceDeviceId: 'source-21', destinationDeviceId: 'destination-21',
        sourcePath: '/synthetic/source', targetPath: '/synthetic/target',
        stagePath: '/synthetic/target.part',
        sourceSha256: sha256, totalBytes: content.length,
      };
      const admission: BrokerOwnerEpochAdmission = {
        ownerEpoch: 11, grantGeneration: 7,
        deviceEpoch: randomUUID(), sessionEpoch: randomUUID(), privilege: 'CORE',
      };
      const persisted: PersistedEpoch = {
        ...admission, ownerId: binding.ownerId, deviceId: binding.destinationDeviceId,
      };
      const route: AuthenticatedTransferRoute = {
        ownerId: binding.ownerId, projectId: binding.projectId,
        sourceDeviceId: binding.sourceDeviceId,
        destinationDeviceId: binding.destinationDeviceId, epoch: 5,
      };
      const worker: FencedWorkerJournalSnapshot = {
        id, accountId: binding.ownerId, projectId: binding.projectId,
        sourceDeviceId: binding.sourceDeviceId, targetDeviceId: binding.destinationDeviceId,
        sourcePath: binding.sourcePath, targetPath: binding.targetPath,
        stagePath: binding.stagePath, bytesTotal: content.length,
        bytesConfirmed: 0, sha256, state: 'MUTATION_UNKNOWN',
        errorCode: 'FORGED_WRITE_RECEIPT',
        fencing: { epoch: 27, token: 'synthetic-worker-lease-token-long-enough-00000001' },
        pending: {
          requestId, epoch: 27, offset: 0, length: content.length,
          sha256, dispatched: true,
        },
      };
      const checkpoint: TransferCheckpoint = {
        binding, revision: 17, epoch: 5, offset: 0, status: 'unknown',
        pending: {
          requestId, epoch: 4, offset: 0, length: content.length,
          sha256, ackObserved: false,
        },
      };
      const snapshot = { worker, checkpoint, route, admission };
      await fsyncJson(localFile, snapshot);
      await fsyncJson(externalFile, persisted);

      // A synthetic signer reads the durable witness store, NOT the local WAL.
      // An actual production implementation must instead use protected Broker
      // signing and independent anti-rollback storage.
      const macFor = (c: BrokerOwnerEpochChallenge) =>
        createHmac('sha256', signerKey).update(wire(c)).digest('hex');
      const verify = (saved: SignedResponse, challenge: BrokerOwnerEpochChallenge) => {
        if (!/^[0-9a-f]{64}$/.test(saved.mac) ||
            saved.challenge.challengeNonce !== challenge.challengeNonce ||
            wire(saved.challenge) !== wire(challenge)) return false;
        return timingSafeEqual(Buffer.from(saved.mac, 'hex'),
          Buffer.from(macFor(challenge), 'hex'));
      };
      const same = (c: BrokerOwnerEpochChallenge, current: PersistedEpoch) =>
        c.ownerId === current.ownerId && c.deviceId === current.deviceId &&
        c.ownerEpoch === current.ownerEpoch &&
        c.grantGeneration === current.grantGeneration &&
        c.deviceEpoch === current.deviceEpoch &&
        c.sessionEpoch === current.sessionEpoch &&
        c.privilege === current.privilege;
      let oldSigned: SignedResponse | undefined;
      let readbackCalls = 0;
      let witnessCalls = 0;
      const witness: BrokerOwnerEpochWitness = {
        assertFresh: async challenge => {
          witnessCalls++;
          const fresh = JSON.parse(await fs.readFile(externalFile, 'utf8')) as PersistedEpoch;
          if (!same(challenge, fresh)) return false;
          const signed: SignedResponse = {
            challenge: { ...challenge }, mac: macFor(challenge),
          };
          oldSigned ??= signed;
          return verify(signed, challenge);
        },
      };
      const inspect = (base: typeof snapshot, proof: BrokerOwnerEpochWitness) =>
        inspectOneCallWorkerConnectionJournal({
          worker: base.worker, checkpoint: base.checkpoint, route: base.route,
          ownerAdmission: base.admission,
          authorize: async () => true,
          workerLease: { check: async () => true },
          sessionWitness: { currentEpoch: async () => base.route.epoch },
          ownerEpochWitness: proof,
          stageReadback: {
            inspect: async (w, p) => {
              readbackCalls++;
              return { kind: 'verified' as const, deviceId: w.targetDeviceId,
                offset: p.offset, length: p.length, sha256: p.sha256 };
            },
          },
        });

      // Before rollback: fresh nonce + current mock external witness permits
      // read-only observation, NOT commit, Native dispatch or replay.
      const before = await inspect(snapshot, witness);
      assert.equal(before.state, 'readback_verified_not_committed');
      assert.equal(before.automaticallyReplayable, false);
      assert.equal(before.externalSideEffectProven, false);
      assert.equal(before.mutationExecuted, false);
      assert.equal(before.checkpointAdvanced, false);
      assert.equal(readbackCalls, 1);
      assert.equal(witnessCalls, 2);
      assert.ok(oldSigned, 'initial authenticated challenge must be recorded');
      const archived = oldSigned!;
      assert.equal(verify(archived, archived.challenge), true,
        'old MAC stays cryptographically valid: freshness is a separate check');

      // Advance only the synthetic EXTERNAL durable high-water. A complete
      // local rollback restores the earlier worker/checkpoint/owner admission.
      const advanced: PersistedEpoch = {
        ...persisted, ownerEpoch: 12, grantGeneration: 8,
        sessionEpoch: randomUUID(),
      };
      await fsyncJson(externalFile, advanced);
      const reopened = JSON.parse(await fs.readFile(localFile, 'utf8')) as typeof snapshot;
      assert.deepEqual(reopened, snapshot, 'local rollback preserves stale signed-looking claims');
      const stale = await inspect(reopened, witness);
      assert.equal(stale.state, 'authority_blocked',
        'persisted HIGHER external owner epoch must defeat rolled-back local proof');
      assert.equal(stale.automaticallyReplayable, false);
      assert.equal(stale.checkpointAdvanced, false);
      assert.equal(stale.externalSideEffectProven, false);
      assert.equal(readbackCalls, 1, 'no stage read on stale authenticated admission');

      // The MAC is valid for its OLD challenge, but not for the new random
      // challenge or current external ownerEpoch. WAL-cached proof is not an
      // authenticated read-only Broker witness.
      const replay: BrokerOwnerEpochWitness = {
        assertFresh: async challenge => {
          const current = JSON.parse(await fs.readFile(externalFile, 'utf8')) as PersistedEpoch;
          return same(challenge, current) && verify(archived, challenge);
        },
      };
      const denied = await inspect(reopened, replay);
      assert.equal(denied.state, 'authority_blocked');
      assert.equal(denied.automaticallyReplayable, false);
      assert.equal(readbackCalls, 1);
      assert.equal(reopened.worker.state, 'MUTATION_UNKNOWN');
      assert.equal(reopened.worker.errorCode, 'FORGED_WRITE_RECEIPT');
      assert.equal(reopened.worker.pending?.requestId, requestId);
      assert.equal(reopened.worker.pending?.dispatched, true);
      assert.equal(reopened.worker.bytesConfirmed, 0);
      assert.equal(reopened.checkpoint.offset, 0);
      assert.equal(JSON.stringify(reopened), JSON.stringify(snapshot),
        'inspection never mutates worker, checkpoint, pending or owner context');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
