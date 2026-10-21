import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CrossDeviceTransferJobs, type TransferJob, type TransferRemote }
  from '../src/mcp/cross-device-transfer-jobs.js';
import { type TrustedTransferAuthority, type TrustedTransferCoreGrants }
  from '../src/workspace/artifact-job-trust.js';

// #21 independent negative: newly instantiated Hub journal reader cannot turn
// a wrong-ACK, possibly dispatched Native mutation into a clean cancellation.
// Only synthetic memory and a disposable local temporary journal are touched.
const account = 'account:qa21-reopen-owner';
const req = {
  accountId: account, projectId: 'Nexowire',
  sourceDeviceId: 'synthetic-qa21-source', targetDeviceId: 'synthetic-qa21-target',
  sourcePath: '/synthetic/source', targetPath: '/synthetic/destination',
};
const content = Buffer.alloc(65_536, 0x71);
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');

test('#588: reopened Hub repeated cancel/status cannot erase forged-ACK pending or replay', 
  { timeout: 15_000 }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa21-reopen-unknown-'));
    try {
      const token = 'synthetic-only-not-real-external-monotonic-cas-epoch';
      const auth: TrustedTransferAuthority = {
        acquire: async () => ({ epoch: 1, token }),
        assertCurrent: async (_job, lease) => {
          assert.equal(lease.epoch, 1);
          assert.equal(lease.token, token);
        },
      };
      const grants: TrustedTransferCoreGrants = {
        assertCurrent: async job => {
          assert.equal(job.accountId, account);
          assert.equal(job.projectId, req.projectId);
          assert.equal(job.sourceDeviceId, req.sourceDeviceId);
          assert.equal(job.targetDeviceId, req.targetDeviceId);
        },
      };
      let stage = Buffer.alloc(0), writes = 0, published = 0;
      const remote: TransferRemote = {
        stat: async device => ({
          type: 'file', size: device === req.sourceDeviceId ? content.length : stage.length,
        }),
        hash: async device => hash(device === req.sourceDeviceId ? content : stage),
        read: async (device, _file, offset, count) => {
          const bytes = (device === req.sourceDeviceId ? content : stage).subarray(offset, offset + count);
          return {
            sourceBytes: device === req.sourceDeviceId ? content.length : stage.length,
            offsetBytes: offset, bytesRead: bytes.length, contentBase64: bytes.toString('base64'),
          };
        },
        write: async () => { throw Error('UNFENCED_WRITE_DENIED'); },
        moveNoOverwrite: async () => { throw Error('UNFENCED_PUBLISH_DENIED'); },
        writeFenced: async (_job, env, data, first) => {
          const bytes = Buffer.from(data, 'base64');
          assert.equal(first, true);
          assert.equal(env.offset, 0);
          assert.equal(hash(bytes), env.sha256);
          assert.equal(stage.length, 0, 'a pending request must never be resent');
          stage = Buffer.from(bytes);
          writes++;
          return {
            // Wrong requestId is an adversarial ACK; all other fields correlate.
            requestId: randomUUID(), epoch: env.epoch, offset: env.offset,
            length: env.length, sha256: env.sha256,
          };
        },
        publishFenced: async () => { published++; throw Error('PUBLISH_DENIED'); },
      };
      const ctor = () => new CrossDeviceTransferJobs(dir, remote, {
        requireExternalAuthority: true, authority: auth, grants,
      });
      const first = ctor();
      const started = await first.start(req);
      await first.waitForIdle(started.id);
      const filename = path.join(dir, started.id + '.json');
      const before = JSON.parse(await fs.readFile(filename, 'utf8')) as TransferJob;
      assert.equal(before.state, 'MUTATION_UNKNOWN');
      assert.equal(before.errorCode, 'FORGED_WRITE_RECEIPT');
      assert.equal(before.bytesConfirmed, 0);
      assert.equal(before.pending?.offset, 0);
      assert.equal(before.pending?.length, content.length);
      assert.equal(stage.length, content.length);
      assert.equal(writes, 1);
      const persistedId = before.pending!.requestId;

      // Another CrossDeviceTransferJobs instance has no in-memory worker state,
      // yet the journal and the remote physical side effect are still real.
      const reopened = ctor();
      for (let n = 0; n < 3; n++) {
        const [cancelled, inspected] = await Promise.all([
          reopened.cancel(started.id, account, req.sourceDeviceId, req.targetDeviceId),
          reopened.status(started.id, account, req.sourceDeviceId, req.targetDeviceId),
        ]);
        assert.equal(cancelled.state, 'MUTATION_UNKNOWN');
        assert.equal(cancelled.bytesConfirmed, 0);
        assert.equal(inspected.state, 'MUTATION_UNKNOWN');
        assert.equal(inspected.bytesConfirmed, 0);
      }
      const after = JSON.parse(await fs.readFile(filename, 'utf8')) as TransferJob;
      assert.equal(after.state, 'MUTATION_UNKNOWN');
      assert.equal(after.pending?.requestId, persistedId);
      assert.equal(after.pending?.offset, before.pending?.offset);
      assert.equal(after.pending?.length, before.pending?.length);
      assert.equal(after.pending?.sha256, before.pending?.sha256);
      assert.equal(after.pending?.epoch, before.pending?.epoch);
      assert.equal(after.errorCode, 'FORGED_WRITE_RECEIPT');
      assert.equal(after.bytesConfirmed, 0);
      assert.equal(writes, 1, 'read-only status and repeat cancellation must not replay');
      assert.equal(published, 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
