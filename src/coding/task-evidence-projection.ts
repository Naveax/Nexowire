/**
 * #45: Read-only, allowlisted task provenance for a single authorized viewer.
 * This module does not verify signatures, contact an external CAS, authorize
 * native effects, or turn local audit/worker claims into completion proof.
 */
export type TaskEvidenceState =
  | 'ACCESS_DENIED' | 'CORRELATION_CONFLICT' | 'UNKNOWN'
  | 'NOT_ESTABLISHED' | 'IN_PROGRESS_UNVERIFIED'
  | 'SUCCEEDED_UNVERIFIED' | 'FAILED_UNVERIFIED';
export type WitnessClass =
  | 'ABSENT' | 'MALFORMED' | 'SCOPE_MISMATCH'
  | 'UNVERIFIED_CLAIM' | 'REVOKED_CLAIM' | 'UNKNOWN_CLAIM';

export interface TaskEvidenceScope {
  ownerId: string;
  deviceId: string;
  taskId: string;
  worktreeId: string;
  sourceSha: string;
  logicalMutationId: string;
  requestId: string;
  ownerEpoch: number;
  issuerEpoch: number;
}
export interface TaskEvidenceViewer {
  ownerId: string;
  deviceId: string;
}
export interface TaskEvidenceInput {
  /** Scope MUST come from an authenticated owner/device authority, not logs. */
  scope: TaskEvidenceScope;
  /** Viewer MUST come from authenticated caller/session context. */
  viewer: TaskEvidenceViewer;
  /** Read-only journal.inspect() projection; requestId is its only native join. */
  journal?: unknown;
  /** AuditLog rows are deliberately untrusted, even when status=succeeded. */
  auditRows?: readonly unknown[];
  /** Progress state from an external worker is a report, never native proof. */
  progress?: unknown;
  /** Serialized receipt claim, NOT a verified signature. */
  signedIssuerReceipt?: unknown;
  /** Serialized off-host CAS claim, NOT a trusted external CAS readback. */
  externalCasWitness?: unknown;
  /** Trusted operation correlation only; AuditLog has no task/owner fields. */
  auditOperationId?: string;
}
export interface TaskEvidenceProjection {
  schemaVersion: 1;
  status: TaskEvidenceState;
  identity?: Readonly<TaskEvidenceScope>;
  receipt: WitnessClass;
  externalCas: WitnessClass;
  audit: Readonly<{ started: number; succeeded: number; failed: number; unknown: number }>;
  progress: 'ABSENT' | 'UNTRUSTED_REPORT' | 'SCOPE_MISMATCH';
  /** Never exported as verified by this source-only, read-only boundary. */
  completedVerified: false;
  coreEffective: false;
  mayDispatch: false;
  requiresIndependentReceiptVerifier: true;
  requiresOffHostCas: true;
}

const emptyCounts = () => ({ started: 0, succeeded: 0, failed: 0, unknown: 0 });
const own = (x: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(x, key);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
const safeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:@+/-]{0,159}$/.test(value);
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const epoch = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
const ID_KEYS = ['ownerId','deviceId','taskId','worktreeId',
  'sourceSha','logicalMutationId','requestId','ownerEpoch','issuerEpoch'] as const;
function validScope(s: TaskEvidenceScope): boolean {
  return safeId(s.ownerId) && safeId(s.deviceId) && safeId(s.taskId) &&
    safeId(s.worktreeId) && sha(s.sourceSha) && safeId(s.logicalMutationId) &&
    safeId(s.requestId) && epoch(s.ownerEpoch) && epoch(s.issuerEpoch);
}
function matchesScope(data: Record<string, unknown>, scope: TaskEvidenceScope): boolean {
  return ID_KEYS.every(k => own(data, k) && data[k] === scope[k]);
}
function classifyClaim(claim: unknown, scope: TaskEvidenceScope, kind: 'receipt'|'cas'): WitnessClass {
  if (claim === undefined || claim === null) return 'ABSENT';
  const x = record(claim);
  if (!x) return 'MALFORMED';
  if (!matchesScope(x, scope)) return 'SCOPE_MISMATCH';
  // A field called verified=true, a fake signature or status=committed is
  // never cryptographic or rollback-independent verification.
  if (kind === 'receipt') {
    if (!safeId(x.issuerKeyId) || !safeId(x.receiptId) ||
        typeof x.signature !== 'string' || x.signature.length < 1 ||
        x.signature.length > 4096) return 'MALFORMED';
    return 'UNVERIFIED_CLAIM';
  }
  if (!safeId(x.witnessId) || !safeId(x.issuerKeyId)) return 'MALFORMED';
  if (x.status === 'revoked') return 'REVOKED_CLAIM';
  if (x.status === 'unknown') return 'UNKNOWN_CLAIM';
  if (x.status === 'committed' || x.status === 'reserved') return 'UNVERIFIED_CLAIM';
  return 'MALFORMED';
}
function classifyProgress(value: unknown, scope: TaskEvidenceScope):
  TaskEvidenceProjection['progress'] {
  if (value === undefined || value === null) return 'ABSENT';
  const x = record(value);
  if (!x || !matchesScope(x, scope)) return 'SCOPE_MISMATCH';
  return 'UNTRUSTED_REPORT';
}
function journalState(value: unknown, requestId: string): TaskEvidenceState {
  if (value === undefined || value === null) return 'NOT_ESTABLISHED';
  const x = record(value);
  if (!x || x.requestId !== requestId) return 'CORRELATION_CONFLICT';
  if (x.status === 'unknown') return 'UNKNOWN';
  if (x.status === 'in_progress') return 'IN_PROGRESS_UNVERIFIED';
  if (x.status === 'succeeded') return 'SUCCEEDED_UNVERIFIED';
  if (x.status === 'failed') return 'FAILED_UNVERIFIED';
  return 'CORRELATION_CONFLICT';
}

/** Pure projection. Never forwards raw audit messages, tokens, signatures or worker output. */
export function projectTaskEvidence(input: TaskEvidenceInput): TaskEvidenceProjection {
  const denied: TaskEvidenceProjection = {
    schemaVersion: 1, status: 'ACCESS_DENIED',
    receipt: 'ABSENT', externalCas: 'ABSENT', audit: emptyCounts(),
    progress: 'ABSENT', completedVerified: false, coreEffective: false,
    mayDispatch: false, requiresIndependentReceiptVerifier: true,
    requiresOffHostCas: true,
  };
  const { scope, viewer } = input;
  if (!scope || !viewer || !validScope(scope) ||
      !safeId(viewer.ownerId) || !safeId(viewer.deviceId) ||
      viewer.ownerId !== scope.ownerId || viewer.deviceId !== scope.deviceId) {
    return denied; // Constant-shape denial prevents cross-device existence leaks.
  }
  const counts = emptyCounts();
  // AuditLog operationId is NOT a requestId or a logicalMutationId. A caller
  // must provide a separate, authority-pinned operationId; unmatched rows
  // are invisible. Even matched rows remain *untrusted diagnostic counts*.
  if (safeId(input.auditOperationId) && Array.isArray(input.auditRows)) {
    for (const row of input.auditRows.slice(0, 500)) {
      const x = record(row);
      if (!x || x.operationId !== input.auditOperationId || x.targetId !== scope.deviceId) continue;
      const status = x.status;
      if (status === 'started' || status === 'succeeded' ||
          status === 'failed' || status === 'unknown') counts[status]++;
    }
  }
  return {
    schemaVersion: 1,
    status: journalState(input.journal, scope.requestId),
    identity: Object.freeze(Object.fromEntries(ID_KEYS.map(k => [k, scope[k]])) as unknown as TaskEvidenceScope),
    receipt: classifyClaim(input.signedIssuerReceipt, scope, 'receipt'),
    externalCas: classifyClaim(input.externalCasWitness, scope, 'cas'),
    progress: classifyProgress(input.progress, scope),
    audit: Object.freeze(counts),
    completedVerified: false,
    coreEffective: false,
    mayDispatch: false,
    requiresIndependentReceiptVerifier: true,
    requiresOffHostCas: true,
  };
}
