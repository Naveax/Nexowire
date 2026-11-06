import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  ReviewedGitPatch,
  type JournalEntry,
  type ReviewedIdentity,
  type ReviewedPatchPorts,
  type ReviewedRequest,
} from '../src/coding/reviewed-git-patch.js';

const digest = (b: Uint8Array): string =>
  createHash('sha256').update(b).digest('hex');
const base = 'a'.repeat(40);
const source = 'b'.repeat(40);

function identity(root: string): ReviewedIdentity {
  return {
    ownerId: 'owner1', taskId: 'task1', worktreeId: 'worktree1',
    worktreeRoot: root, baseSha: base, sourceSha: source,
    approvalEpoch: 7,
  };
}

/**
 * TEST-ONLY fake, not a production CAS or durable journal implementation.
 * Simulates the atomic contract against real TEMP files for deterministic
 * negative cases; no installed Agent, Broker, UAC, Git hooks or native effects.
 */
class TempFixture implements ReviewedPatchPorts {
  id: ReviewedIdentity;
  revoked = false;
  generation = 1;
  casCount = 0;
  approves: Array<'APPLY' | 'UNDO'> = [];
  mutateBeforeCas: (() => Promise<void>) | null = null;
  lostAck = false;
  failReceipt = false;
  entries = new Map<string, JournalEntry>();
  constructor(readonly root: string, readonly filename = 'a.txt') {
    this.id = identity(root);
  }
  private full(file: string): string {
    assert.equal(file, this.filename);
    return path.join(this.root, file);
  }
  async attest(): Promise<ReviewedIdentity & { revoked: boolean }> {
    return { ...this.id, revoked: this.revoked };
  }
  async read(file: string): Promise<{ bytes: Uint8Array; version: string }> {
    return {
      bytes: await fs.readFile(this.full(file)),
      version: String(this.generation),
    };
  }
  async externalWrite(content: string): Promise<void> {
    await fs.writeFile(this.full(this.filename), content, 'utf8');
    this.generation += 1;
  }
  async replaceIfCurrent(input: {
    file: string;
    beforeSha256: string;
    beforeVersion: string;
    authority: ReviewedIdentity;
    replacement: Uint8Array;
  }): Promise<boolean> {
    if (this.mutateBeforeCas) {
      const callback = this.mutateBeforeCas;
      this.mutateBeforeCas = null;
      await callback();
    }
    const current = await this.read(input.file);
    if (this.revoked || JSON.stringify(input.authority) !== JSON.stringify(this.id) ||
        digest(current.bytes) !== input.beforeSha256 ||
        current.version !== input.beforeVersion) return false;
    this.casCount += 1;
    await this.externalWrite(Buffer.from(input.replacement).toString('utf8'));
    if (this.lostAck) throw new Error('AFTER_EFFECT_LOST_ACK');
    return true;
  }
  async verifyApproval(input: {
    identity: ReviewedIdentity;
    file: string;
    fingerprint: string;
    phase: 'APPLY' | 'UNDO';
    ticket: string;
  }): Promise<boolean> {
    if (input.ticket !== `human-${input.phase.toLowerCase()}`) return false;
    if (JSON.stringify(input.identity) !== JSON.stringify(this.id)) return false;
    this.approves.push(input.phase);
    return true;
  }
  journal = {
    begin: async (key: string, entry: JournalEntry): Promise<boolean> => {
      if (this.entries.has(key)) return false;
      this.entries.set(key, structuredClone(entry));
      return true;
    },
    get: async (key: string): Promise<JournalEntry | null> => {
      const e = this.entries.get(key);
      return e ? structuredClone(e) : null;
    },
    complete: async (
      key: string,
      state: 'VERIFIED' | 'CONFLICT',
      afterVersion?: string,
    ): Promise<void> => {
      if (this.failReceipt) throw new Error('LOST_DURABLE_RECEIPT');
      const item = this.entries.get(key);
      assert.ok(item && item.state === 'PENDING');
      this.entries.set(key, { ...item, state, ...(afterVersion ? { afterVersion } : {}) });
    },
  };
}

async function fixture(): Promise<{
  root: string;
  port: TempFixture;
  patch: ReviewedGitPatch;
  request: ReviewedRequest;
  clean: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-32-reviewed-'));
  const port = new TempFixture(root);
  await fs.writeFile(path.join(root, 'a.txt'), 'before\n', 'utf8');
  return {
    root, port, patch: new ReviewedGitPatch(port),
    request: { identity: identity(root), file: 'a.txt', replacement: 'after\n' },
    clean: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test('#32 preview produces bounded unified diff without any mutation or approval', async () => {
  const x = await fixture();
  try {
    const preview = await x.patch.preview(x.request);
    assert.match(preview.diff, /diff --git a\/a.txt b\/a.txt/);
    assert.match(preview.diff, /-before\n\+after\n/);
    assert.match(preview.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(preview.beforeSha256, digest(Buffer.from('before\n')));
    assert.equal(x.port.entries.size, 0);
    assert.equal(x.port.casCount, 0);
    assert.deepEqual(x.port.approves, []);
    assert.equal(await fs.readFile(path.join(x.root, 'a.txt'), 'utf8'), 'before\n');
  } finally { await x.clean(); }
});

test('#32 independent human ticket and exact review fingerprint are mandatory', async () => {
  const x = await fixture();
  try {
    const preview = await x.patch.preview(x.request);
    assert.equal((await x.patch.apply(x.request, preview, 'self-approved')).state, 'DENIED');
    assert.equal(x.port.casCount, 0);
    assert.equal(x.port.entries.size, 0);
    const tampered = { ...preview, diff: preview.diff + '# tamper' };
    assert.equal((await x.patch.apply(x.request, tampered, 'human-apply')).state, 'CONFLICT');
    assert.equal(x.port.casCount, 0);
    assert.equal(x.port.entries.size, 0);
  } finally { await x.clean(); }
});

test('#32 authorized apply verifies postimage and exact-only filesystem undo', async () => {
  const x = await fixture();
  try {
    const preview = await x.patch.preview(x.request);
    const applied = await x.patch.apply(x.request, preview, 'human-apply');
    assert.equal(applied.state, 'VERIFIED');
    assert.equal(applied.state === 'VERIFIED' && applied.sha256, digest(Buffer.from('after\n')));
    assert.equal(await fs.readFile(path.join(x.root, 'a.txt'), 'utf8'), 'after\n');
    const undone = await x.patch.undo({
      identity: x.request.identity, file: 'a.txt',
      fingerprint: preview.fingerprint, ticket: 'human-undo',
    });
    assert.equal(undone.state, 'VERIFIED');
    assert.equal(await fs.readFile(path.join(x.root, 'a.txt'), 'utf8'), 'before\n');
    assert.equal(x.port.casCount, 2);
    // The same mutation or undo can never be blindly repeated.
    assert.equal((await x.patch.undo({
      identity: x.request.identity, file: 'a.txt',
      fingerprint: preview.fingerprint, ticket: 'human-undo',
    })).state, 'MUTATION_STATE_UNKNOWN');
  } finally { await x.clean(); }
});

test('#32 stale preimage, newer generation and Git source SHA drift conflict without write', async () => {
  for (const mode of ['bytes', 'version', 'source'] as const) {
    const x = await fixture();
    try {
      const preview = await x.patch.preview(x.request);
      if (mode === 'bytes') await x.port.externalWrite('someone else\n');
      if (mode === 'version') await x.port.externalWrite('before\n');
      if (mode === 'source') x.port.id = { ...x.port.id, sourceSha: 'c'.repeat(40) };
      const result = await x.patch.apply(x.request, preview, 'human-apply');
      assert.equal(result.state, 'CONFLICT');
      assert.equal(x.port.casCount, 0);
      assert.equal(x.port.entries.size, 0);
    } finally { await x.clean(); }
  }
});

test('#32 concurrency drift inside final CAS rejects without replacing concurrent file', async () => {
  const x = await fixture();
  try {
    const preview = await x.patch.preview(x.request);
    x.port.mutateBeforeCas = () => x.port.externalWrite('concurrent\n');
    const result = await x.patch.apply(x.request, preview, 'human-apply');
    assert.equal(result.state, 'CONFLICT');
    assert.equal(x.port.casCount, 0);
    assert.equal(await fs.readFile(path.join(x.root, 'a.txt'), 'utf8'), 'concurrent\n');
  } finally { await x.clean(); }
});

test('#32 lost ACK after mutation is UNKNOWN and cannot retry or blind undo', async () => {
  const x = await fixture();
  try {
    const preview = await x.patch.preview(x.request);
    x.port.lostAck = true;
    const first = await x.patch.apply(x.request, preview, 'human-apply');
    assert.equal(first.state, 'MUTATION_STATE_UNKNOWN');
    assert.equal(x.port.casCount, 1);
    assert.equal(await fs.readFile(path.join(x.root, 'a.txt'), 'utf8'), 'after\n');
    assert.equal((await x.patch.apply(x.request, preview, 'human-apply')).state, 'MUTATION_STATE_UNKNOWN');
    assert.equal((await x.patch.undo({
      identity: x.request.identity, file: 'a.txt',
      fingerprint: preview.fingerprint, ticket: 'human-undo',
    })).state, 'MUTATION_STATE_UNKNOWN');
    assert.equal(x.port.casCount, 1);
  } finally { await x.clean(); }
});

test('#32 lost durable publication receipt stays UNKNOWN instead of VERIFIED', async () => {
  const x = await fixture();
  try {
    const preview = await x.patch.preview(x.request);
    x.port.failReceipt = true;
    assert.equal((await x.patch.apply(x.request, preview, 'human-apply')).state,
      'MUTATION_STATE_UNKNOWN');
    assert.equal(x.port.casCount, 1);
    assert.equal((await x.patch.undo({
      identity: x.request.identity, file: 'a.txt',
      fingerprint: preview.fingerprint, ticket: 'human-undo',
    })).state, 'MUTATION_STATE_UNKNOWN');
  } finally { await x.clean(); }
});

test('#32 post-apply edits block undo even with a valid human ticket', async () => {
  const x = await fixture();
  try {
    const preview = await x.patch.preview(x.request);
    assert.equal((await x.patch.apply(x.request, preview, 'human-apply')).state, 'VERIFIED');
    await x.port.externalWrite('operator edits\n');
    assert.equal((await x.patch.undo({
      identity: x.request.identity, file: 'a.txt',
      fingerprint: preview.fingerprint, ticket: 'human-undo',
    })).state, 'CONFLICT');
    assert.equal(await fs.readFile(path.join(x.root, 'a.txt'), 'utf8'), 'operator edits\n');
    assert.equal(x.port.casCount, 1);
  } finally { await x.clean(); }
});

test('#32 revoke / approval epoch change / wrong task prevent apply', async () => {
  const x = await fixture();
  try {
    const preview = await x.patch.preview(x.request);
    x.port.revoked = true;
    assert.notEqual((await x.patch.apply(x.request, preview, 'human-apply')).state, 'VERIFIED');
    x.port.revoked = false;
    x.port.id = { ...x.port.id, approvalEpoch: 8 };
    assert.notEqual((await x.patch.apply(x.request, preview, 'human-apply')).state, 'VERIFIED');
    assert.equal(x.port.casCount, 0);
  } finally { await x.clean(); }
});

test('#32 denies traversal, .git metadata, binary text and oversized preview', async () => {
  const x = await fixture();
  try {
    for (const file of ['../escape', '.git/config', 'sub/../a.txt', 'C:/a.txt', 'sub\\a.txt']) {
      await assert.rejects(() => x.patch.preview({ ...x.request, file }));
    }
    await assert.rejects(() => x.patch.preview({
      ...x.request, replacement: 'binary\0\n',
    }));
    await assert.rejects(() => x.patch.preview({
      ...x.request, replacement: 'x'.repeat(70_000) + '\n',
    }));
    assert.equal(x.port.casCount, 0);
  } finally { await x.clean(); }
});


test('#32 preview accepts an existing empty UTF-8 file without performing any patch', async () => {
  const x = await fixture();
  try {
    await x.port.externalWrite('');
    const preview = await x.patch.preview(x.request);
    assert.equal(preview.beforeSha256, digest(Buffer.alloc(0)));
    assert.match(preview.diff, /^@@ -0,0 \+1,1 @@$/m);
    assert.match(preview.diff, /^\+after$/m);
    assert.equal(await fs.readFile(path.join(x.root, 'a.txt'), 'utf8'), '');
    assert.equal(x.port.entries.size, 0);
    assert.equal(x.port.casCount, 0);
    assert.deepEqual(x.port.approves, []);
  } finally { await x.clean(); }
});

test('#32 preview rejects hidden terminal and bidi controls in before and after text', async () => {
  const x = await fixture();
  try {
    for (const replacement of [
      'safe\u001b[31m forged\n',
      'safe\u0008forged\n',
      'review\u202Etxt\n',
      'review\u2066txt\n',
      '\uFEFFsurprise\n',
    ]) {
      await assert.rejects(
        () => x.patch.preview({ ...x.request, replacement }),
        /ONLY_UTF8_LF_TEXT_SUPPORTED/,
      );
    }
    await x.port.externalWrite('before\u202Eforged\n');
    await assert.rejects(
      () => x.patch.preview(x.request),
      /ONLY_UTF8_LF_TEXT_SUPPORTED/,
    );
    assert.equal(await fs.readFile(path.join(x.root, 'a.txt'), 'utf8'), 'before\u202Eforged\n');
    assert.equal(x.port.entries.size, 0);
    assert.equal(x.port.casCount, 0);
    assert.deepEqual(x.port.approves, []);
  } finally { await x.clean(); }
});

test('#32 stale approved preimage is readonly CONFLICT, never an effect or approval', async () => {
  for (const content of ['concurrent different bytes\n', 'before\n']) {
    const x = await fixture();
    try {
      const reviewed = await x.patch.preview(x.request);
      assert.equal(await x.patch.comparePreview(x.request, reviewed), 'MATCH');
      // Same bytes with a newer generation must also invalidate review.
      await x.port.externalWrite(content);
      assert.equal(await x.patch.comparePreview(x.request, reviewed), 'CONFLICT');
      assert.equal((await x.patch.apply(x.request, reviewed, 'human-apply')).state, 'CONFLICT');
      assert.equal(x.port.casCount, 0);
      assert.deepEqual(x.port.approves, []);
      assert.equal(x.port.entries.size, 0);
      assert.equal(await fs.readFile(path.join(x.root, 'a.txt'), 'utf8'), content);
    } finally { await x.clean(); }
  }
});

test('#32 source, base, worktree identity and attested digest drift reject prior review', async () => {
  for (const scope of ['sourceSha', 'baseSha', 'worktreeId', 'worktreeRoot', 'worktreeSha256'] as const) {
    const x = await fixture();
    try {
      const signedScope: ReviewedIdentity = {
        ...x.request.identity,
        worktreeSha256: 'c'.repeat(64),
      };
      x.request.identity = signedScope;
      x.port.id = { ...signedScope };
      const reviewed = await x.patch.preview(x.request);
      assert.equal(await x.patch.comparePreview(x.request, reviewed), 'MATCH');
      const changed = scope === 'worktreeSha256' ? 'd'.repeat(64)
        : scope === 'sourceSha' || scope === 'baseSha' ? 'd'.repeat(40)
        : scope === 'worktreeId' ? 'other-worktree'
        : path.join(x.root, 'other-worktree');
      x.port.id = { ...x.port.id, [scope]: changed };
      assert.equal(await x.patch.comparePreview(x.request, reviewed), 'CONFLICT', scope);
      assert.equal((await x.patch.apply(x.request, reviewed, 'human-apply')).state,
        'CONFLICT', scope);
      assert.equal(x.port.casCount, 0, scope);
      assert.equal(x.port.entries.size, 0, scope);
      assert.deepEqual(x.port.approves, [], scope);
      assert.equal(await fs.readFile(path.join(x.root, 'a.txt'), 'utf8'), 'before\n');
    } finally { await x.clean(); }
  }
});

test('#32 matching new source/worktree cannot reuse stale old fingerprint', async () => {
  const x = await fixture();
  try {
    const old = await x.patch.preview(x.request);
    const changed: ReviewedIdentity = {
      ...x.request.identity,
      sourceSha: 'd'.repeat(40),
      worktreeSha256: 'e'.repeat(64),
    };
    x.port.id = { ...changed };
    x.request.identity = changed;
    assert.equal(await x.patch.comparePreview(x.request, old), 'CONFLICT');
    assert.equal((await x.patch.apply(x.request, old, 'human-apply')).state, 'CONFLICT');
    assert.equal(x.port.casCount, 0);
    assert.equal(x.port.entries.size, 0);
    assert.deepEqual(x.port.approves, []);
  } finally { await x.clean(); }
});

test('#32 worktree digest must be a valid SHA256 when supplied', async () => {
  const x = await fixture();
  try {
    const malformed = { ...x.request, identity: {
      ...x.request.identity, worktreeSha256: 'not-sha',
    } };
    await assert.rejects(() => x.patch.preview(malformed), /INVALID_WORKTREE_DIGEST/);
    assert.equal(x.port.casCount, 0);
    assert.equal(x.port.entries.size, 0);
  } finally { await x.clean(); }
});
