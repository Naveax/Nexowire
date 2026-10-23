import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ReviewedGitPatch,
  type JournalEntry,
  type ReviewedIdentity,
  type ReviewedPatchPorts,
  type ReviewedPreview,
  type ReviewedRequest,
} from '../src/coding/reviewed-git-patch.js';

/**
 * #28 independent QA against the ACTUAL #32 ReviewedGitPatch source API.
 * The CAS and journal ports below are deterministic, TEST-ONLY models.
 * They cannot attest Windows kernel atomicity, power-loss fsync, external CAS,
 * services, registry, installed Agent or actual OS side-effect compensation.
 */
const sha = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

class RecoveryPort implements ReviewedPatchPorts {
  readonly identity: ReviewedIdentity;
  readonly entries = new Map<string, JournalEntry>();
  generation = 1;
  replaceAttempts = 0;
  successfulReplaces = 0;
  failUndoBeforeEffect = false;
  failUndoAfterEffectAck = false;
  failUndoReceipt = false;
  concurrentUndoEdit = false;

  constructor(readonly worktree: string) {
    this.identity = {
      ownerId: 'owner-28', taskId: 'task-28',
      worktreeId: 'worktree-28', worktreeRoot: worktree,
      baseSha: 'a'.repeat(40), sourceSha: 'b'.repeat(40),
      approvalEpoch: 7,
    };
  }

  private filename(file: string): string {
    assert.equal(file, 'task.txt', 'Only the fixture file may be touched');
    return path.join(this.worktree, file);
  }

  async attest(): Promise<ReviewedIdentity & { revoked: boolean }> {
    return { ...this.identity, revoked: false };
  }

  async read(file: string): Promise<{ bytes: Uint8Array; version: string }> {
    return {
      bytes: await fs.readFile(this.filename(file)),
      version: String(this.generation),
    };
  }

  async externalEdit(text: string): Promise<void> {
    await fs.writeFile(this.filename('task.txt'), text, 'utf8');
    this.generation += 1;
  }

  async replaceIfCurrent(input: {
    file: string; beforeSha256: string; beforeVersion: string;
    authority: ReviewedIdentity; replacement: Uint8Array;
  }): Promise<boolean> {
    this.replaceAttempts += 1;
    const undo = Buffer.from(input.replacement).toString('utf8') === 'before\n';
    if (undo && this.failUndoBeforeEffect) {
      throw new Error('SIMULATED_CRASH_AFTER_UNDO_JOURNAL_BEFORE_CAS');
    }
    if (undo && this.concurrentUndoEdit) {
      this.concurrentUndoEdit = false;
      await this.externalEdit('newer human edit\n');
    }
    const current = await this.read(input.file);
    if (JSON.stringify(input.authority) !== JSON.stringify(this.identity) ||
        sha(current.bytes) !== input.beforeSha256 ||
        current.version !== input.beforeVersion) return false;
    await fs.writeFile(this.filename(input.file), input.replacement);
    this.generation += 1;
    this.successfulReplaces += 1;
    if (undo && this.failUndoAfterEffectAck) {
      throw new Error('SIMULATED_LOST_ACK_AFTER_UNDO_FILE_EFFECT');
    }
    return true;
  }

  async verifyApproval(input: {
    identity: ReviewedIdentity; file: string; fingerprint: string;
    phase: 'APPLY' | 'UNDO'; ticket: string;
  }): Promise<boolean> {
    return input.ticket === 'separate-human-' + input.phase.toLowerCase() &&
      JSON.stringify(input.identity) === JSON.stringify(this.identity);
  }

  readonly journal = {
    begin: async (key: string, entry: JournalEntry): Promise<boolean> => {
      if (this.entries.has(key)) return false;
      this.entries.set(key, structuredClone(entry));
      return true;
    },
    get: async (key: string): Promise<JournalEntry | null> => {
      const entry = this.entries.get(key);
      return entry ? structuredClone(entry) : null;
    },
    complete: async (
      key: string, state: 'VERIFIED' | 'CONFLICT', afterVersion?: string,
    ): Promise<void> => {
      if (key.startsWith('reviewed-git-patch:UNDO:') && this.failUndoReceipt) {
        throw new Error('SIMULATED_DURABLE_UNDO_RECEIPT_LOST');
      }
      const old = this.entries.get(key);
      assert.ok(old && old.state === 'PENDING');
      this.entries.set(key, { ...old, state,
        ...(afterVersion ? { afterVersion } : {}) });
    },
  };
}

async function makeFixture(): Promise<{
  temp: string; root: string; ports: RecoveryPort;
  patch: ReviewedGitPatch; request: ReviewedRequest; preview: ReviewedPreview;
}> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nx28-813-undo-recovery-'));
  const root = path.join(temp, 'scoped-worktree');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'task.txt'), 'before\n');
  const ports = new RecoveryPort(root);
  const patch = new ReviewedGitPatch(ports);
  const request: ReviewedRequest = {
    identity: ports.identity, file: 'task.txt', replacement: 'after\n',
  };
  const preview = await patch.preview(request);
  assert.equal((await patch.apply(request, preview, 'separate-human-apply')).state,
    'VERIFIED');
  return { temp, root, ports, patch, request, preview };
}

function undoArgs(x: Awaited<ReturnType<typeof makeFixture>>) {
  return {
    identity: x.request.identity, file: x.request.file,
    fingerprint: x.preview.fingerprint, ticket: 'separate-human-undo',
  };
}

test('#28 UNDO: lost ACK after actual TEMP file restore stays UNKNOWN and no re-dispatch', async () => {
  const x = await makeFixture();
  try {
    // Deliberately simulate a separate, non-Git effect in a disposable file.
    // This is NOT a real Windows service or registry mutation.
    const external = path.join(x.temp, 'external-effect-observation.txt');
    await fs.writeFile(external, 'effect-still-present\n');
    x.ports.failUndoAfterEffectAck = true;
    const result = await x.patch.undo(undoArgs(x));
    assert.equal(result.state, 'MUTATION_STATE_UNKNOWN');
    assert.equal(await fs.readFile(path.join(x.root, 'task.txt'), 'utf8'),
      'before\n', 'filesystem effect occurred before the ACK was lost');
    assert.equal(x.ports.successfulReplaces, 2);
    const journal = await x.ports.journal.get(
      'reviewed-git-patch:UNDO:' + x.preview.fingerprint);
    assert.equal(journal?.state, 'PENDING');

    // New source engine, same test journal: an unresolved original mutation
    // must not be dispatched twice, even if the bytes look restored.
    const restarted = new ReviewedGitPatch(x.ports);
    assert.equal((await restarted.undo(undoArgs(x))).state,
      'MUTATION_STATE_UNKNOWN');
    assert.equal(x.ports.replaceAttempts, 2);
    assert.equal(await fs.readFile(external, 'utf8'), 'effect-still-present\n',
      'filesystem-only UNDO must not claim external effect compensation');
  } finally { await fs.rm(x.temp, { recursive: true, force: true }); }
});

test('#28 UNDO: concurrent human edit at final CAS is CONFLICT, not overwrite', async () => {
  const x = await makeFixture();
  try {
    x.ports.concurrentUndoEdit = true;
    const result = await x.patch.undo(undoArgs(x));
    assert.equal(result.state, 'CONFLICT');
    assert.equal(await fs.readFile(path.join(x.root, 'task.txt'), 'utf8'),
      'newer human edit\n');
    assert.equal(x.ports.successfulReplaces, 1,
      'only the original APPLY may have replaced the file');
    assert.equal((await x.ports.journal.get(
      'reviewed-git-patch:UNDO:' + x.preview.fingerprint))?.state, 'CONFLICT');
  } finally { await fs.rm(x.temp, { recursive: true, force: true }); }
});

test('#28 UNDO: crash after persisted PENDING before write denies retry on restart', async () => {
  const x = await makeFixture();
  try {
    x.ports.failUndoBeforeEffect = true;
    assert.equal((await x.patch.undo(undoArgs(x))).state,
      'MUTATION_STATE_UNKNOWN');
    assert.equal(await fs.readFile(path.join(x.root, 'task.txt'), 'utf8'),
      'after\n');
    assert.equal((await x.ports.journal.get(
      'reviewed-git-patch:UNDO:' + x.preview.fingerprint))?.state, 'PENDING');
    const attempts = x.ports.replaceAttempts;
    const restarted = new ReviewedGitPatch(x.ports);
    assert.equal((await restarted.undo(undoArgs(x))).state,
      'MUTATION_STATE_UNKNOWN');
    assert.equal(x.ports.replaceAttempts, attempts,
      'no second filesystem dispatch after uncertain PENDING');
  } finally { await fs.rm(x.temp, { recursive: true, force: true }); }
});

test('#28 UNDO: lost durable VERIFIED receipt after file restore is not success', async () => {
  const x = await makeFixture();
  try {
    x.ports.failUndoReceipt = true;
    assert.equal((await x.patch.undo(undoArgs(x))).state,
      'MUTATION_STATE_UNKNOWN');
    assert.equal(await fs.readFile(path.join(x.root, 'task.txt'), 'utf8'),
      'before\n');
    assert.equal((await x.ports.journal.get(
      'reviewed-git-patch:UNDO:' + x.preview.fingerprint))?.state, 'PENDING');
    assert.equal((await new ReviewedGitPatch(x.ports).undo(undoArgs(x))).state,
      'MUTATION_STATE_UNKNOWN');
    assert.equal(x.ports.successfulReplaces, 2);
  } finally { await fs.rm(x.temp, { recursive: true, force: true }); }
});
