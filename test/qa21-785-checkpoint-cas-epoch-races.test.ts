import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { TransferJob } from '../src/mcp/cross-device-transfer-jobs.js';
import { ArtifactBridgeStore, ArtifactBridgeError } from '../src/workspace/artifact-bridge.js';
import { VerifiedTransferCheckpointAdapter } from '../src/workspace/artifact-job-checkpoint.js';
import { TransferTrustError, type TrustedPublicationCommit }
  from '../src/workspace/artifact-job-trust.js';

/**
 * #21 independent QA on exact #785. Native issuer, signed external CAS,
 * grant and stored Artifact data are entirely synthetic fixtures.
 *
 * These tests exercise a DIFFERENT boundary from #762's THREE unchanged
 * strict CrossDeviceTransferJobs tests. Do not modify, skip or greenwash
 * those original adversarial assertions with this checkpoint-only suite.
 */
const payload = Buffer.alloc(65_536 + 29, 0x53);
const sha256 = (content: Buffer) => createHash('sha256').update(content).digest('hex');
const digest = sha256(payload);
const repository = 'Naveax/Nexowire';
const commitSha = 'a'.repeat(40);
const artifactPath = 'transfer/qa21-checkpoint-785.bin';

type IndependentLedger = TrustedPublicationCommit & {
  issuer: string;
  ownerEpoch: number;
  grantGeneration: number;
  signature: string;
};

async function fsyncJson(filename: string, value: unknown) {
  const handle = await fs.open(filename, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function isolated(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-qa21-785-'));
  try { await fn(dir); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}

function completedJob(): TransferJob {
  const id = randomUUID(), requestId = randomUUID();
  const now = new Date().toISOString();
  return {
    version: 1, id,
    accountId: 'owner-qa21', projectId: 'Nexowire',
    sourceDeviceId: 'source-qa21', targetDeviceId: 'target-qa21',
    sourcePath: '/synthetic/source', targetPath: '/synthetic/target',
    stagePath: '/synthetic/target.part',
    bytesTotal: payload.length, bytesConfirmed: payload.length,
    sha256: digest, state: 'COMPLETED', createdAt: now, updatedAt: now,
    fencing: { epoch: 31, token: 'synthetic-worker-fence-' + randomUUID() },
    publication: {
      requestId, epoch: 31, sha256: digest, dispatched: true,
      durableCommitId: 'synthetic-protected-commit-' + randomUUID(),
    },
  };
}

async function prepared(root: string) {
  const job = completedJob();
  const scope = {
    accountId: job.accountId, projectId: job.projectId,
    deviceId: job.targetDeviceId,
  };
  const bridge = new ArtifactBridgeStore(path.join(root, 'artifact-manifest-store'));
  const session = await bridge.begin({
    scope, artifactPath, repository, commitSha,
    producerOperationId: job.id, size: payload.length, sha256: digest,
    testStatus: 'unverified', acceptanceStatus: 'pending',
  });
  assert.equal(session.state, 'OPEN');
  assert.ok(session.sessionId);
  for (let offset = 0; offset < payload.length; offset += 65_536) {
    await bridge.putChunk(scope, session.sessionId, offset,
      payload.subarray(offset, offset + 65_536).toString('base64'));
  }
  await bridge.commit(scope, session.sessionId);
  const input = {
    scope, job, workspaceId: 'qa21-checkpoint-rollback',
    artifactPath, repository, commitSha,
  };
  return { bridge, job, input, scope };
}

function syntheticSignedLedger(root: string, job: TransferJob) {
  const filename = path.join(root, 'separate-synthetic-external-cas.json');
  const signingKey = randomBytes(32); // never in local Artifact job/checkpoint JSON
  const issuer = 'fixture-native-cas-issuer-qa21';
  const issuerEpoch = 71, generation = 9;
  const fields = (c: Omit<IndependentLedger, 'signature'>) => JSON.stringify([
    c.issuer, c.ownerEpoch, c.grantGeneration,
    c.jobId, c.requestId, c.epoch, c.sha256, c.durableCommitId,
  ]);
  const sign = (c: Omit<IndependentLedger, 'signature'>) =>
    createHmac('sha256', signingKey).update(fields(c)).digest('hex');
  const create = (id: string): IndependentLedger => {
    const pub = job.publication!;
    const claims: Omit<IndependentLedger, 'signature'> = {
      issuer, ownerEpoch: issuerEpoch, grantGeneration: generation,
      jobId: job.id, requestId: pub.requestId, epoch: pub.epoch,
      sha256: job.sha256, durableCommitId: id,
    };
    return { ...claims, signature: sign(claims) };
  };
  const inspect = async (): Promise<TrustedPublicationCommit | null> => {
    const row = JSON.parse(await fs.readFile(filename, 'utf8')) as IndependentLedger;
    const { signature, issuer: providerIssuer, ownerEpoch,
      grantGeneration, ...receipt } = row;
    const recomputed = sign({
      ...receipt, issuer: providerIssuer, ownerEpoch, grantGeneration,
    });
    if (providerIssuer !== issuer || ownerEpoch !== issuerEpoch ||
        grantGeneration !== generation || !/^[0-9a-f]{64}$/.test(signature) ||
        !timingSafeEqual(Buffer.from(signature, 'hex'),
          Buffer.from(recomputed, 'hex'))) {
      return null;
    }
    return receipt;
  };
  return { filename, create, inspect };
}

const isCode = (code: string) => (error: unknown) =>
  error instanceof ArtifactBridgeError && error.code === code;

test('#21 #785: newer independent CAS receipt after manifest read cannot validate rolled-back local COMPLETED',
  { timeout: 15_000 }, async () => isolated(async root => {
    const { bridge, job, input, scope } = await prepared(root);
    const localSnapshot = JSON.stringify(job);
    const external = syntheticSignedLedger(root, job);
    await fsyncJson(external.filename, external.create(job.publication!.durableCommitId!));
    let inspections = 0, grants = 0;
    const adapter = new VerifiedTransferCheckpointAdapter(bridge, {
      assertCurrent: async () => { grants++; },
    }, {
      inspect: async () => {
        const result = await external.inspect();
        inspections++;
        if (inspections === 1) {
          // Advance the INDEPENDENT signed CAS high-water after the first
          // verification; the local completed job is deliberately NOT updated.
          await fsyncJson(external.filename, external.create(
            'later-independent-external-commit-' + randomUUID()));
        }
        return result;
      },
    });
    await assert.rejects(adapter.persist(input),
      isCode('JOB_PUBLICATION_COMMIT_MISMATCH'));
    assert.equal(inspections, 2,
      'checkpoint guard must re-read independently after awaiting manifest');
    assert.ok(grants >= 3);
    assert.equal(await bridge.getCheckpoint(scope, input.workspaceId), null,
      'no cross-chat checkpoint may be persisted from a stale local CAS');
    assert.equal(JSON.stringify(job), localSnapshot,
      'the test must not rewrite forensic worker state or immutable requestId');
  }));

test('#21 #785: CORE owner revoked after second protected CAS readback cannot persist checkpoint',
  { timeout: 15_000 }, async () => isolated(async root => {
    const { bridge, job, input, scope } = await prepared(root);
    const external = syntheticSignedLedger(root, job);
    await fsyncJson(external.filename, external.create(job.publication!.durableCommitId!));
    let inspections = 0, checks = 0;
    const adapter = new VerifiedTransferCheckpointAdapter(bridge, {
      assertCurrent: async () => {
        checks++;
        // First proof check: pre/post. After manifest, repeat pre/post.
        // A revoke at the last boundary MUST override a valid CAS.
        if (checks >= 4) throw new TransferTrustError('CORE_OWNER_REVOKED',
          'Synthetic authoritative CORE owner epoch advanced at final check');
      },
    }, {
      inspect: async () => { inspections++; return external.inspect(); },
    });
    await assert.rejects(adapter.persist(input),
      (e: unknown) => e instanceof TransferTrustError &&
        e.code === 'CORE_OWNER_REVOKED');
    assert.equal(inspections, 2,
      'both independently authenticated CAS readbacks must happen');
    assert.equal(checks, 4, 'final post-readback owner check must be enforced');
    assert.equal(await bridge.getCheckpoint(scope, input.workspaceId), null);
    assert.equal(job.state, 'COMPLETED',
      'read-only adapter must not silently mutate local completed source state');
  }));

test('#21 #785 + #780: full-byte UNKNOWN with forged ACK error cannot be saved as completed checkpoint',
  { timeout: 15_000 }, async () => isolated(async root => {
    const { bridge, job, input, scope } = await prepared(root);
    const hostile: TransferJob = {
      ...job, state: 'MUTATION_UNKNOWN', errorCode: 'FORGED_WRITE_RECEIPT',
      // Deliberately retain the apparently plausible local final commit,
      // bytesConfirmed==bytesTotal and an UNKNOWN second mutation envelope.
      // None of that upgrades UNKNOWN to verified COMPLETED.
      pending: {
        requestId: randomUUID(), epoch: job.fencing!.epoch,
        offset: 65_536, length: payload.length - 65_536,
        sha256: sha256(payload.subarray(65_536)), dispatched: true,
      },
    };
    const original = JSON.stringify(hostile);
    const external = syntheticSignedLedger(root, job);
    await fsyncJson(external.filename, external.create(job.publication!.durableCommitId!));
    let inspections = 0;
    const adapter = new VerifiedTransferCheckpointAdapter(bridge, {
      assertCurrent: async () => undefined,
    }, {
      inspect: async () => { inspections++; return external.inspect(); },
    });
    await assert.rejects(adapter.persist({ ...input, job: hostile }),
      isCode('JOB_NOT_VERIFIED'));
    assert.equal(inspections, 0,
      'UNKNOWN MUST fail before any signed-looking receipt can be promoted');
    assert.equal(await bridge.getCheckpoint(scope, input.workspaceId), null);
    assert.equal(hostile.errorCode, 'FORGED_WRITE_RECEIPT');
    assert.equal(hostile.state, 'MUTATION_UNKNOWN');
    assert.equal(hostile.pending?.dispatched, true);
    assert.equal(JSON.stringify(hostile), original,
      'checkpoint validation must preserve original typed error and pending');
  }));
