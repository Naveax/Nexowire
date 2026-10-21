import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CrossDeviceTransferJobs, type TransferRemote, type TransferJob } from '../src/mcp/cross-device-transfer-jobs.js';
import type { TrustedTransferAuthority, TrustedTransferCoreGrants } from '../src/workspace/artifact-job-trust.js';

test('#08 cancels a reserved but not dispatched Native intent without any side effect', { timeout: 20000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nex-08-reserved-not-dispatched-'));
  let entered!: () => void, unblock!: () => void;
  const atGate = new Promise<void>(r => { entered = r; });
  const releaseGate = new Promise<void>(r => { unblock = r; });
  const data = Buffer.alloc(221 * 1024, 0x55);
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const input = { accountId: 'account:owner', projectId: 'Nexowire',
    sourceDeviceId: 'source', sourcePath: '/fixture/in.bin',
    targetDeviceId: 'target', targetPath: '/fixture/out.bin' };
  let held = false, dispatched = 0, published = 0;
  const authority: TrustedTransferAuthority = {
    acquire: async () => ({epoch:1,token:'SYNTHETIC-ONLY-TOKEN-WITH-ENOUGH-LENGTH'}),
    assertCurrent: async (job, proof, stage) => {
      assert.equal(proof.epoch, 1);
      if (stage === 'WRITE' && !held) {
        const j = JSON.parse(await fs.readFile(path.join(root, job.id + '.json'), 'utf8')) as TransferJob;
        if (j.pending) { held = true; entered(); await releaseGate; }
      }
    },
  };
  const grants: TrustedTransferCoreGrants = { assertCurrent: async () => undefined };
  const remote: TransferRemote = {
    stat: async device => ({type:'file',size:device==='source'?data.length:0}),
    hash: async () => sha(data),
    read: async (device, _file, offset, length) => {
      const b = data.subarray(offset,offset+length);
      assert.equal(device,'source');
      return {sourceBytes:data.length,offsetBytes:offset,bytesRead:b.length,contentBase64:b.toString('base64')};
    },
    write: async () => { throw Error('LEGACY_WRITER_MUST_NOT_RUN'); },
    moveNoOverwrite: async () => { throw Error('LEGACY_PUBLISH_MUST_NOT_RUN'); },
    writeFenced: async () => {
      dispatched++;
      throw Error('CANCELLED_BEFORE_DISPATCH_BUT_REMOTE_CALLED');
    },
    publishFenced: async () => { published++; },
  };
  const jobs = new CrossDeviceTransferJobs(root, remote,
    {requireExternalAuthority:true,authority,grants});
  try {
    const started = await jobs.start(input);
    try {
      await atGate; // proves durable pending exists, but Native writer NOT called
      const j = JSON.parse(await fs.readFile(path.join(root, started.id + '.json'),'utf8')) as TransferJob;
      assert.ok(j.pending);
      assert.equal(j.pending?.dispatched, false, 'the journal was reserved but not sent');
      assert.equal(dispatched,0);
      const cancel = await jobs.cancel(started.id,input.accountId,input.sourceDeviceId,input.targetDeviceId);
      assert.equal(cancel.state,'CANCEL_REQUESTED');
    } finally { unblock(); await jobs.waitForIdle(started.id); }
    const j = JSON.parse(await fs.readFile(path.join(root, started.id + '.json'),'utf8')) as TransferJob;
    assert.equal(j.state,'CANCELLED','no Native call actually happened');
    assert.equal(j.bytesConfirmed,0);
    assert.equal(j.pending,undefined,'undispatched reserved intent is not a lost ACK');
    assert.equal(dispatched,0);
    assert.equal(published,0);
  } finally { unblock(); await fs.rm(root,{recursive:true,force:true}); }
});
