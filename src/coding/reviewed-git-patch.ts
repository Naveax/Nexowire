/**
 * #780 P1 reviewed Git-compatible patch gate.
 *
 * This module does not spawn Git or grant access. Callers MUST provide a trusted
 * root-scoped, symlink-safe filesystem port with a truly atomic CAS replacement
 * (file version + bytes SHA + revocation epoch checked in the same commit), an
 * independent human-approval verifier and a durable monotonic journal.
 *
 * No such production adapter is registered here. In particular, plain
 * fs.rename, PathPolicy, a Git config switch or a local process mutex does NOT
 * implement the required atomic CAS / OS sandbox contract.
 *
 * Scope: one existing UTF-8 LF file per reviewed mutation. It does not undo
 * registry, services, processes, native OS or any other external effects.
 */
import { createHash } from 'node:crypto';

export interface ReviewedIdentity {
  ownerId: string;
  taskId: string;
  worktreeId: string;
  worktreeRoot: string;
  baseSha: string;
  sourceSha: string;
  approvalEpoch: number;
}

export interface ReviewedRequest {
  identity: ReviewedIdentity;
  file: string;
  replacement: string;
}

export interface FileWitness {
  bytes: Uint8Array;
  /** Trusted opaque inode/generation witness, not a user-supplied timestamp. */
  version: string;
}

export interface ReviewedPreview {
  identity: ReviewedIdentity;
  file: string;
  beforeSha256: string;
  beforeVersion: string;
  afterSha256: string;
  fingerprint: string;
  diff: string;
}

export type PatchPhase = 'APPLY' | 'UNDO';
export type PatchResult =
  | { state: 'VERIFIED'; sha256: string; fingerprint: string }
  | { state: 'CONFLICT' | 'DENIED' | 'MUTATION_STATE_UNKNOWN'; fingerprint: string };

export interface JournalEntry {
  phase: PatchPhase;
  identity: ReviewedIdentity;
  file: string;
  fingerprint: string;
  beforeBase64: string;
  beforeSha256: string;
  afterSha256: string;
  /** The verified generation of the file following the operation. */
  afterVersion?: string;
  state: 'PENDING' | 'VERIFIED' | 'CONFLICT';
}

export interface ReviewedPatchPorts {
  /** Independently attest the Git HEAD/base and live owner/worktree epoch. */
  attest(): Promise<ReviewedIdentity & { revoked: boolean }>;
  /** Root-scoped read. Must reject symlinks, hard boundary escapes and special files. */
  read(file: string): Promise<FileWitness>;
  /**
   * Atomically CAS content SHA, generation AND authority/epoch, or return false
   * without any filesystem effect. A failure/timeout after entry may mean UNKNOWN.
   * Implementations cannot substitute read-check-then-rename.
   */
  replaceIfCurrent(input: {
    file: string;
    beforeSha256: string;
    beforeVersion: string;
    authority: ReviewedIdentity;
    replacement: Uint8Array;
  }): Promise<boolean>;
  /** Independent human approval. No self-issued approval by the coding agent. */
  verifyApproval(input: {
    identity: ReviewedIdentity;
    file: string;
    fingerprint: string;
    phase: PatchPhase;
    ticket: string;
  }): Promise<boolean>;
  /**
   * Atomic, fsync-durable, monotonic journal. begin returns false for an
   * existing key, including PENDING/UNKNOWN after crash or lost ACK.
   * complete must never silently downgrade a VERIFIED record.
   */
  journal: {
    begin(key: string, entry: JournalEntry): Promise<boolean>;
    get(key: string): Promise<JournalEntry | null>;
    complete(key: string, state: 'VERIFIED' | 'CONFLICT', afterVersion?: string): Promise<void>;
  };
}

const MAX_FILE = 64 * 1024;
const MAX_DIFF = 192 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateIdentity(identity: ReviewedIdentity): void {
  for (const v of [identity.ownerId, identity.taskId, identity.worktreeId]) {
    if (typeof v !== 'string' || !/^[\w.:-]{1,160}$/.test(v)) {
      throw new Error('INVALID_REVIEW_IDENTITY');
    }
  }
  if (typeof identity.worktreeRoot !== 'string' ||
      !identity.worktreeRoot || !/^(?:\/|[A-Za-z]:[\\/])/.test(identity.worktreeRoot)) {
    throw new Error('INVALID_WORKTREE_ROOT');
  }
  for (const v of [identity.baseSha, identity.sourceSha]) {
    if (typeof v !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v)) {
      throw new Error('INVALID_GIT_SHA');
    }
  }
  if (!Number.isSafeInteger(identity.approvalEpoch) || identity.approvalEpoch < 0) {
    throw new Error('INVALID_APPROVAL_EPOCH');
  }
}

function validateFile(file: string): void {
  if (typeof file !== 'string' || file.length > 512 || file.length === 0 ||
      file.includes('\\') || file.startsWith('/') || file.includes(':') ||
      file.includes('\0')) throw new Error('INVALID_PATCH_PATH');
  const parts = file.split('/');
  if (parts.length > 12 || parts.some(p =>
    p === '.' || p === '..' || !/^[A-Za-z0-9_.-]{1,100}$/.test(p) ||
    p.toLowerCase() === '.git' || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p) ||
    p.endsWith('.') || p.endsWith(' ')
  )) throw new Error('INVALID_PATCH_PATH');
}

function lines(s: string): string[] {
  // Empty regular files are valid LF text. A reviewed diff must not contain
  // terminal-control or bidirectional-formatting instructions that could
  // disguise the bytes a human is asked to approve.
  if ((s.length > 0 && !s.endsWith('\n')) ||
      s.includes('\r') ||
      /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u.test(s)) {
    throw new Error('ONLY_UTF8_LF_TEXT_SUPPORTED');
  }
  return s.length === 0 ? [] : s.slice(0, -1).split('\n');
}

function decodeBounded(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_FILE) throw new Error('PATCH_SIZE_LIMIT');
  const text = decoder.decode(bytes);
  lines(text);
  return text;
}

function equalIdentity(a: ReviewedIdentity, b: ReviewedIdentity): boolean {
  return a.ownerId === b.ownerId && a.taskId === b.taskId &&
    a.worktreeId === b.worktreeId && a.worktreeRoot === b.worktreeRoot &&
    a.baseSha === b.baseSha && a.sourceSha === b.sourceSha &&
    a.approvalEpoch === b.approvalEpoch;
}

function unifiedDiff(file: string, oldText: string, newText: string): string {
  const before = lines(oldText);
  const after = lines(newText);
  const oldStart = before.length ? 1 : 0;
  const newStart = after.length ? 1 : 0;
  const diff = [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${oldStart},${before.length} +${newStart},${after.length} @@`,
    ...before.map(s => '-' + s),
    ...after.map(s => '+' + s),
    '',
  ].join('\n');
  if (Buffer.byteLength(diff) > MAX_DIFF) throw new Error('PATCH_DIFF_LIMIT');
  return diff;
}

function operationKey(phase: PatchPhase, fingerprint: string): string {
  return `reviewed-git-patch:${phase}:${fingerprint}`;
}

export class ReviewedGitPatch {
  constructor(private readonly ports: ReviewedPatchPorts) {}

  private async authority(identity: ReviewedIdentity): Promise<boolean> {
    const current = await this.ports.attest();
    return !current.revoked && equalIdentity(current, identity);
  }

  private async observe(request: ReviewedRequest): Promise<{
    preview: ReviewedPreview;
    beforeBytes: Uint8Array;
  }> {
    validateIdentity(request.identity);
    validateFile(request.file);
    if (!await this.authority(request.identity)) throw new Error('AUTHORITY_DENIED');
    const afterBytes = encoder.encode(request.replacement);
    if (afterBytes.byteLength > MAX_FILE) throw new Error('PATCH_SIZE_LIMIT');
    const afterText = decodeBounded(afterBytes);
    const witness = await this.ports.read(request.file);
    const beforeText = decodeBounded(witness.bytes);
    if (!witness.version || witness.version.length > 256) throw new Error('INVALID_FILE_VERSION');
    const beforeSha256 = sha(witness.bytes);
    const afterSha256 = sha(afterBytes);
    if (beforeSha256 === afterSha256) throw new Error('EMPTY_REVIEW_DIFF');
    const diff = unifiedDiff(request.file, beforeText, afterText);
    const payload = {
      identity: request.identity,
      file: request.file,
      beforeSha256,
      beforeVersion: witness.version,
      afterSha256,
      diff,
    };
    const fingerprint = sha(encoder.encode(JSON.stringify(payload)));
    if (!await this.authority(request.identity)) throw new Error('AUTHORITY_DENIED');
    return { preview: { ...payload, fingerprint }, beforeBytes: witness.bytes };
  }

  /** Read-only: no Git subprocess, file write, journal write or approval issuance. */
  async preview(request: ReviewedRequest): Promise<ReviewedPreview> {
    return (await this.observe(request)).preview;
  }

  async apply(
    request: ReviewedRequest,
    reviewed: ReviewedPreview,
    ticket: string,
  ): Promise<PatchResult> {
    const fingerprint = reviewed.fingerprint;
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) {
      return { state: 'DENIED', fingerprint: String(fingerprint) };
    }
    // Check this *before* reading the potentially changed file: an old PENDING
    // record means the previous attempt may have changed bytes before ACK loss.
    // Stale content must never erase UNKNOWN provenance on retry.
    try {
      if (await this.ports.journal.get(operationKey('APPLY', fingerprint))) {
        return { state: 'MUTATION_STATE_UNKNOWN', fingerprint };
      }
    } catch {
      return { state: 'MUTATION_STATE_UNKNOWN', fingerprint };
    }
    let observed: Awaited<ReturnType<ReviewedGitPatch['observe']>>;
    try {
      observed = await this.observe(request);
      if (observed.preview.fingerprint !== fingerprint ||
          JSON.stringify(observed.preview) !== JSON.stringify(reviewed)) {
        return { state: 'CONFLICT', fingerprint };
      }
      if (!await this.ports.verifyApproval({
        identity: request.identity, file: request.file,
        fingerprint, phase: 'APPLY', ticket,
      }) || !await this.authority(request.identity)) {
        return { state: 'DENIED', fingerprint };
      }
    } catch {
      return { state: 'CONFLICT', fingerprint };
    }

    const key = operationKey('APPLY', fingerprint);
    const entry: JournalEntry = {
      phase: 'APPLY', identity: request.identity, file: request.file, fingerprint,
      beforeBase64: Buffer.from(observed.beforeBytes).toString('base64'),
      beforeSha256: observed.preview.beforeSha256,
      afterSha256: observed.preview.afterSha256,
      state: 'PENDING',
    };
    // Any uncertain begin, replace, post-read or durable ACK => UNKNOWN.
    try {
      if (!await this.ports.journal.begin(key, entry)) {
        return { state: 'MUTATION_STATE_UNKNOWN', fingerprint };
      }
      const didReplace = await this.ports.replaceIfCurrent({
        file: request.file,
        beforeSha256: entry.beforeSha256,
        beforeVersion: observed.preview.beforeVersion,
        authority: request.identity,
        replacement: encoder.encode(request.replacement),
      });
      if (!didReplace) {
        await this.ports.journal.complete(key, 'CONFLICT');
        return { state: 'CONFLICT', fingerprint };
      }
      const after = await this.ports.read(request.file);
      if (sha(after.bytes) !== entry.afterSha256 ||
          !after.version || !await this.authority(request.identity)) {
        return { state: 'MUTATION_STATE_UNKNOWN', fingerprint };
      }
      await this.ports.journal.complete(key, 'VERIFIED', after.version);
      return { state: 'VERIFIED', sha256: entry.afterSha256, fingerprint };
    } catch {
      return { state: 'MUTATION_STATE_UNKNOWN', fingerprint };
    }
  }

  /**
   * Only the exact recorded filesystem preimage may be restored. The APPLY
   * journal must be VERIFIED, and the current bytes AND generation must match
   * its independently read-back post-apply witness.
   */
  async undo(input: {
    identity: ReviewedIdentity;
    file: string;
    fingerprint: string;
    ticket: string;
  }): Promise<PatchResult> {
    const { identity, file, fingerprint, ticket } = input;
    // An earlier undo may have changed the file before its ACK was lost.
    try {
      if (await this.ports.journal.get(operationKey('UNDO', fingerprint))) {
        return { state: 'MUTATION_STATE_UNKNOWN', fingerprint };
      }
    } catch {
      return { state: 'MUTATION_STATE_UNKNOWN', fingerprint };
    }
    try {
      validateIdentity(identity);
      validateFile(file);
      if (!/^[a-f0-9]{64}$/.test(fingerprint) ||
          !await this.authority(identity)) return { state: 'DENIED', fingerprint };
      const prior = await this.ports.journal.get(operationKey('APPLY', fingerprint));
      if (!prior || prior.state !== 'VERIFIED' || prior.phase !== 'APPLY' ||
          prior.file !== file || prior.fingerprint !== fingerprint ||
          !prior.afterVersion || !equalIdentity(prior.identity, identity)) {
        return { state: 'MUTATION_STATE_UNKNOWN', fingerprint };
      }
      const preimage = Buffer.from(prior.beforeBase64, 'base64');
      if (sha(preimage) !== prior.beforeSha256) {
        return { state: 'MUTATION_STATE_UNKNOWN', fingerprint };
      }
      const current = await this.ports.read(file);
      if (sha(current.bytes) !== prior.afterSha256 ||
          current.version !== prior.afterVersion) {
        return { state: 'CONFLICT', fingerprint };
      }
      if (!await this.ports.verifyApproval({
        identity, file, fingerprint, phase: 'UNDO', ticket,
      }) || !await this.authority(identity)) {
        return { state: 'DENIED', fingerprint };
      }

      const undoKey = operationKey('UNDO', fingerprint);
      const undoEntry: JournalEntry = {
        phase: 'UNDO', identity, file, fingerprint, state: 'PENDING',
        beforeBase64: Buffer.from(current.bytes).toString('base64'),
        beforeSha256: prior.afterSha256, afterSha256: prior.beforeSha256,
      };
      // Begin precedes any effect. No auto-retry following an unknown receipt.
      if (!await this.ports.journal.begin(undoKey, undoEntry)) {
        return { state: 'MUTATION_STATE_UNKNOWN', fingerprint };
      }
      const changed = await this.ports.replaceIfCurrent({
        file, beforeSha256: prior.afterSha256,
        beforeVersion: prior.afterVersion, authority: identity,
        replacement: preimage,
      });
      if (!changed) {
        await this.ports.journal.complete(undoKey, 'CONFLICT');
        return { state: 'CONFLICT', fingerprint };
      }
      const restored = await this.ports.read(file);
      if (sha(restored.bytes) !== prior.beforeSha256 ||
          !restored.version || !await this.authority(identity)) {
        return { state: 'MUTATION_STATE_UNKNOWN', fingerprint };
      }
      await this.ports.journal.complete(undoKey, 'VERIFIED', restored.version);
      return { state: 'VERIFIED', sha256: prior.beforeSha256, fingerprint };
    } catch {
      return { state: 'MUTATION_STATE_UNKNOWN', fingerprint };
    }
  }
}
