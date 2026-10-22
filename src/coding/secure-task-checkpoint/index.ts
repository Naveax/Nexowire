import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'node:crypto';
import {mkdir, open, readFile, rename, unlink} from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';

/**
 * #780/#34: encrypted, metadata-only task context. This is NOT a journal,
 * protected grant verifier, external CAS, or authority to execute a tool.
 */
const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const gitSha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const boundedId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const count = z.number().int().nonnegative().safe();
const positive = z.number().int().positive().safe();
const scopeSchema = z.strictObject({
  ownerId: uuid, deviceId: uuid, taskId: boundedId,
  worktreeId: uuid, sourceSha: gitSha, ownerEpoch: positive,
  grantGeneration: positive, signedGrantScopeDigest: hash,
});
const mutationSchema = z.strictObject({
  logicalMutationId: uuid, requestId: uuid, fingerprint: hash,
  state: z.enum(['PLANNED', 'RESERVED', 'DISPATCH_MAY_HAVE_OCCURRED',
    'RECONCILE_REQUIRED', 'LOCAL_TERMINAL_NEEDS_PROOF']),
  pendingUnknown: z.boolean(),
  originalErrorCode: boundedId.optional(),
});
const budgetSchema = z.strictObject({
  maxSteps: positive, stepsUsed: count, maxTools: positive, toolsUsed: count,
  maxElapsedMs: positive, elapsedMs: count,
});
const approvalSchema = z.strictObject({
  approvalId: uuid, decision: z.enum(['APPROVED', 'REJECTED', 'REVOKED']),
  approvalEpoch: positive, diffFingerprint: hash, grantScopeDigest: hash,
});
const ciSchema = z.strictObject({
  sourceSha: gitSha, workflowId: positive, runId: positive,
  conclusion: z.enum(['SUCCESS', 'FAILURE', 'CANCELLED', 'IN_PROGRESS', 'QUEUED']),
});
const eventSchema = z.strictObject({
  stepId: boundedId,
  phase: z.enum(['PLAN', 'TOOL', 'OBSERVE', 'TEST', 'FIX', 'STOP']),
  outcome: z.enum(['PENDING', 'SUCCEEDED_LOCAL', 'FAILED', 'UNKNOWN']),
  fingerprint: hash,
});
export const SecureTaskCheckpointSchema = z.strictObject({
  version: z.literal(1),
  scope: scopeSchema,
  mutation: mutationSchema,
  budget: budgetSchema,
  cancelled: z.boolean(),
  approvals: z.array(approvalSchema).max(64),
  ciWitnesses: z.array(ciSchema).max(64),
  events: z.array(eventSchema).max(256),
  foldedEvents: z.strictObject({count, digest: hash}).optional(),
}).superRefine((c, ctx) => {
  if (c.budget.stepsUsed > c.budget.maxSteps ||
      c.budget.toolsUsed > c.budget.maxTools ||
      c.budget.elapsedMs > c.budget.maxElapsedMs)
    ctx.addIssue({code: 'custom', message: 'BUDGET_EXCEEDED'});
  if ((c.mutation.state === 'DISPATCH_MAY_HAVE_OCCURRED' ||
       c.mutation.state === 'RECONCILE_REQUIRED' ||
       c.events.some(e => e.outcome === 'UNKNOWN')) && !c.mutation.pendingUnknown)
    ctx.addIssue({code: 'custom', message: 'UNKNOWN_PROVENANCE_REQUIRED'});
  if (c.ciWitnesses.some(w => w.sourceSha !== c.scope.sourceSha))
    ctx.addIssue({code: 'custom', message: 'CI_SOURCE_SHA_MISMATCH'});
  if (c.approvals.some(a => a.grantScopeDigest !== c.scope.signedGrantScopeDigest ||
      a.approvalEpoch !== c.scope.ownerEpoch))
    ctx.addIssue({code: 'custom', message: 'APPROVAL_GRANT_SCOPE_MISMATCH'});
  if (c.mutation.originalErrorCode === 'MUTATION_STATE_UNKNOWN' &&
      !c.mutation.pendingUnknown)
    ctx.addIssue({code: 'custom', message: 'UNKNOWN_ORIGINAL_ERROR_MUST_STICK'});
  if (c.mutation.pendingUnknown && !c.mutation.originalErrorCode)
    ctx.addIssue({code: 'custom', message: 'ORIGINAL_ERROR_REQUIRED'});
  if (new Set(c.approvals.map(a => a.approvalId)).size !== c.approvals.length)
    ctx.addIssue({code: 'custom', message: 'DUPLICATE_APPROVAL'});
  if (new Set(c.ciWitnesses.map(w => w.runId)).size !== c.ciWitnesses.length)
    ctx.addIssue({code: 'custom', message: 'DUPLICATE_CI_RUN'});
});
export type SecureTaskCheckpoint = z.infer<typeof SecureTaskCheckpointSchema>;
export type TrustedCheckpointScope = z.infer<typeof scopeSchema>;
type Verdict = 'STOP' | 'RECONCILE_REQUIRED' | 'INSPECT_ONLY';
export type RestoreResult = Readonly<{
  verdict: Verdict;
  reason: 'CORRUPT_OR_MISSING' | 'SCOPE_OR_GRANT_STALE' | 'GRANT_REVOKED' |
    'CANCELLED' | 'BUDGET_EXHAUSTED' | 'UNKNOWN_NEEDS_EXTERNAL_CAS' |
    'LOCAL_METADATA_NOT_EXECUTION_PROOF';
  snapshot?: Readonly<SecureTaskCheckpoint>;
  revision?: string;
  mayDispatch: false; mayReplay: false; completedVerified: false;
}>;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const fail = (message: string): never => {throw new Error('CHECKPOINT_' + message)};
const envelopeSchema = z.strictObject({
  version: z.literal(1), iv: z.string().regex(/^[a-f0-9]{24}$/),
  tag: z.string().regex(/^[a-f0-9]{32}$/),
  ciphertext: z.string().min(1).max(262144),
});
const AD = 'Nexowire/secure-task-checkpoint/v1/';

function preserve(previous: SecureTaskCheckpoint, next: SecureTaskCheckpoint): void {
  if (!same(previous.scope, next.scope) ||
      !same({logicalMutationId: previous.mutation.logicalMutationId,
             requestId: previous.mutation.requestId,
             fingerprint: previous.mutation.fingerprint},
            {logicalMutationId: next.mutation.logicalMutationId,
             requestId: next.mutation.requestId,
             fingerprint: next.mutation.fingerprint}))
    fail('IMMUTABLE_SCOPE_CHANGED');
  const p = previous.budget, n = next.budget;
  if (p.maxSteps !== n.maxSteps || p.maxTools !== n.maxTools ||
      p.maxElapsedMs !== n.maxElapsedMs || n.stepsUsed < p.stepsUsed ||
      n.toolsUsed < p.toolsUsed || n.elapsedMs < p.elapsedMs)
    fail('BUDGET_RESET');
  if (previous.cancelled && !next.cancelled) fail('CANCELLATION_ERASED');
  if (previous.mutation.pendingUnknown && (!next.mutation.pendingUnknown ||
      next.mutation.originalErrorCode !== previous.mutation.originalErrorCode ||
      next.mutation.state !== previous.mutation.state))
    fail('UNKNOWN_PROVENANCE_ERASED');
  if (previous.mutation.originalErrorCode &&
      next.mutation.originalErrorCode !== previous.mutation.originalErrorCode)
    fail('ORIGINAL_ERROR_ERASED');
  if (!same(next.approvals.slice(0, previous.approvals.length), previous.approvals))
    fail('APPROVAL_HISTORY_ERASED');
  if (!same(next.ciWitnesses.slice(0, previous.ciWitnesses.length), previous.ciWitnesses))
    fail('CI_WITNESS_ERASED');
  // Events may be folded ONLY through compactTaskContext(), which is an
  // explicit operation and retains a chained digest, never approval/UNKNOWN.
  const appended = same(next.foldedEvents, previous.foldedEvents) &&
    same(next.events.slice(0, previous.events.length), previous.events);
  const compacted = compactTaskContext(previous);
  const folded = same(next.foldedEvents, compacted.foldedEvents) &&
    same(next.events, compacted.events);
  if (!appended && !folded) fail('EVENT_HISTORY_CHANGED');
}

/** Only bounded codes, hashes, IDs and counters: no freeform text or output. */
export function compactTaskContext(input: unknown): SecureTaskCheckpoint {
  const old = SecureTaskCheckpointSchema.parse(input);
  if (old.events.length === 0) return structuredClone(old);
  const foldedEvents = {
    count: (old.foldedEvents?.count ?? 0) + old.events.length,
    digest: sha(JSON.stringify({prior: old.foldedEvents?.digest ?? null, events: old.events})),
  };
  return SecureTaskCheckpointSchema.parse({...old, events: [], foldedEvents});
}

/** Do not treat this check as an external monotonic CAS or grant admission. */
export function inspectRestoredCheckpoint(
  snapshot: SecureTaskCheckpoint, expected: TrustedCheckpointScope,
  grantActive: boolean,
): RestoreResult {
  const verdict = (v: Verdict, reason: RestoreResult['reason']): RestoreResult =>
    Object.freeze({verdict: v, reason, snapshot, mayDispatch: false,
      mayReplay: false, completedVerified: false});
  if (!same(snapshot.scope, scopeSchema.parse(expected)))
    return verdict('STOP', 'SCOPE_OR_GRANT_STALE');
  if (!grantActive) return verdict('STOP', 'GRANT_REVOKED');
  if (snapshot.cancelled || snapshot.approvals.some(a => a.decision === 'REVOKED'))
    return verdict('STOP', 'CANCELLED');
  if (snapshot.budget.stepsUsed >= snapshot.budget.maxSteps ||
      snapshot.budget.toolsUsed >= snapshot.budget.maxTools ||
      snapshot.budget.elapsedMs >= snapshot.budget.maxElapsedMs)
    return verdict('STOP', 'BUDGET_EXHAUSTED');
  if (snapshot.mutation.pendingUnknown ||
      snapshot.mutation.state === 'DISPATCH_MAY_HAVE_OCCURRED' ||
      snapshot.mutation.state === 'RECONCILE_REQUIRED')
    return verdict('RECONCILE_REQUIRED', 'UNKNOWN_NEEDS_EXTERNAL_CAS');
  return verdict('INSPECT_ONLY', 'LOCAL_METADATA_NOT_EXECUTION_PROOF');
}

/**
 * Keys must originate from a protected OS secret source, NOT checkpoint JSON,
 * environment dumps, user chat, or this module. Storage directory must be
 * private/trusted. An encrypted local file can be rolled back wholesale.
 */
export class SecureTaskCheckpointStore {
  private readonly key: Buffer;
  constructor(private readonly directory: string, key: Buffer) {
    if (!Buffer.isBuffer(key) || key.length !== 32) fail('KEY_REQUIRED');
    this.key = Buffer.from(key);
  }
  private file(scope: TrustedCheckpointScope): string {
    const {ownerId, deviceId, taskId} = scopeSchema.parse(scope);
    return path.join(this.directory, sha(AD + ownerId + '/' + deviceId + '/' + taskId) + '.enc');
  }
  private encrypt(cp: SecureTaskCheckpoint): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(AD + this.file(cp.scope)));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(cp)), cipher.final()]);
    return JSON.stringify({version: 1, iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('base64')});
  }
  private decrypt(raw: string, scope: TrustedCheckpointScope): SecureTaskCheckpoint {
    if (Buffer.byteLength(raw) > 262144) fail('OVERSIZED');
    const e = envelopeSchema.parse(JSON.parse(raw));
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(e.iv, 'hex'));
    decipher.setAAD(Buffer.from(AD + this.file(scope)));
    decipher.setAuthTag(Buffer.from(e.tag, 'hex'));
    return SecureTaskCheckpointSchema.parse(JSON.parse(
      Buffer.concat([decipher.update(Buffer.from(e.ciphertext, 'base64')), decipher.final()])
        .toString('utf8')));
  }
  private async raw(scope: TrustedCheckpointScope): Promise<string> {
    return readFile(this.file(scope), 'utf8');
  }
  /** Read-only restore. Even a valid AES tag provides NO dispatch permission. */
  async restore(scope: TrustedCheckpointScope, grantActive: boolean): Promise<RestoreResult> {
    try {
      const raw = await this.raw(scope);
      const snapshot = this.decrypt(raw, scope);
      const result = inspectRestoredCheckpoint(snapshot, scope, grantActive);
      return Object.freeze({...result, revision: sha(raw)});
    } catch {
      return Object.freeze({verdict: 'STOP', reason: 'CORRUPT_OR_MISSING',
        mayDispatch: false, mayReplay: false, completedVerified: false});
    }
  }
  /** No replacement of a pre-existing or unreadable record on enrollment. */
  async create(input: unknown): Promise<string> {
    const cp = SecureTaskCheckpointSchema.parse(input);
    await mkdir(this.directory, {recursive: true, mode: 0o700});
    const file = this.file(cp.scope);
    const h = await open(file, 'wx', 0o600);
    try {
      const raw = this.encrypt(cp);
      await h.writeFile(raw, 'utf8');
      await h.sync();
      return sha(raw);
    } finally {await h.close()}
  }
  /**
   * Caller supplies an exact revision and prior metadata; re-read is local,
   * NOT cross-process/off-host CAS. Concurrent writers need protected owner
   * coordination externally. No native execution follows from this call.
   */
  async update(previous: SecureTaskCheckpoint, next: unknown,
    expectedRevision: string): Promise<string> {
    const prior = SecureTaskCheckpointSchema.parse(previous);
    const current = SecureTaskCheckpointSchema.parse(next);
    preserve(prior, current);
    const raw = await this.raw(prior.scope);
    if (sha(raw) !== expectedRevision || !same(this.decrypt(raw, prior.scope), prior))
      fail('STALE_REVISION');
    const file = this.file(prior.scope);
    const temp = file + '.' + randomBytes(12).toString('hex') + '.tmp';
    let h: Awaited<ReturnType<typeof open>> | undefined;
    try {
      h = await open(temp, 'wx', 0o600);
      const encoded = this.encrypt(current);
      await h.writeFile(encoded, 'utf8');
      await h.sync();
      await h.close(); h = undefined;
      // Fail closed on local readback drift. Still NOT an atomic remote CAS.
      if (sha(await this.raw(prior.scope)) !== expectedRevision)
        fail('STALE_REVISION');
      await rename(temp, file);
      return sha(encoded);
    } finally {
      if (h) await h.close();
      await unlink(temp).catch(() => undefined);
    }
  }
}
