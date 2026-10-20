import * as z from 'zod';
import { createHash } from 'node:crypto';
import { verifyResultFiles, type ProgressProofReport, type ProgressProofRequest } from './progress-proof-verifier.js';

/**
 * Application-owned telemetry is deliberately not treated as OS process health
 * or as proof that an artifact has been independently hashed by Nexowire.
 *
 * Emit one newline-terminated stdout record:
 * NEXOWIRE_PROGRESS_V1 {"completed_count":2,"pending_count":8,"failure_count":0}
 */
export const PROGRESS_PREFIX = 'NEXOWIRE_PROGRESS_V1 ';
const MAX_LINE_BYTES = 8192;
const MAX_SESSIONS = 1000;
// Files can be mutated after inspection. Cached disk proof is never permanent.
const MAX_PROOF_AGE_MS = 30_000;

export const WorkerProgressSchema = z.object({
  completed_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  pending_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  failure_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  result_artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  heartbeat: z.boolean().optional(),
  diagnosis: z.enum([
    'rate_limited', 'waiting_network', 'cpu_saturated', 'gpu_saturated',
    'worker_blocked', 'worker_crashed', 'none',
  ]).optional(),
}).strict();

type WorkerProgress = z.infer<typeof WorkerProgressSchema>;
type ProcessState = 'running' | 'exited' | 'lost' | 'orphaned';
export type ProgressState = 'progress_unknown' | 'active' | 'stalled' | 'reported_complete' | 'completed_verified' | 'progress_mismatch' | 'incomplete' | 'failed' | 'lost';
export type ProgressWarningCode =
  | 'QUEUE_GROWING_WITHOUT_COMPLETIONS'
  | 'NO_COMPLETIONS'
  | 'HEARTBEAT_STALE'
  | 'OUTPUT_STALLED'
  | 'PROGRESS_UNKNOWN'
  | 'PROCESS_EXITED_INCOMPLETE'
  | 'PROCESS_EXITED_FAILED'
  | 'WORKER_REPORTED_BLOCKER'
  | 'INVALID_TELEMETRY'
  | 'EVIDENCE_MISMATCH'
  | 'RECONNECT_PROOF_EXPIRED'
  | 'DISK_PROOF_STALE';

export interface ProgressWarning {
  sessionId: string;
  code: ProgressWarningCode;
  at: string;
  diagnosis: string;
  certainty: 'observed' | 'suspected' | 'worker_reported';
  restartAllowed: boolean;
  action: string;
}

interface SessionProgress {
  id: string;
  status: ProcessState;
  exitCode: number | null;
  startedMs: number;
  lastOutputMs: number;
  lastHeartbeatMs?: number;
  lastReportedProgressMs?: number;
  lastCompletedAdvanceMs?: number;
  growthSinceMs?: number;
  lastCompletedCount?: number;
  lastPendingCount?: number;
  sample?: WorkerProgress;
  invalidRecords: number;
  stdoutFragment: string;
  droppingOversizedLine: boolean;
  seenWarningCodes: Set<ProgressWarningCode>;
  evidence?: ProgressProofReport;
  proofGeneration: number;
  pendingReconnect: boolean;
  trustedRequestId?: string;
  lastProgressOutputSha256?: string;
  lastProcessExitedAt?: string;
  reconnectAtMs?: number;
  lastOutputSeq?: number;
  completionAttested: boolean;
}

/**
 * Out-of-band evidence supplied only by a trusted scheduler and immutable
 * storage adapter. A worker's own manifest or stdout MUST NOT supply this.
 * An object with these fields does not itself cryptographically establish
 * storage immutability; production must authenticate the supplying provider.
 */
export interface TrustedCompletionAttestation {
  authority: 'trusted_storage_adapter';
  requestId: string;
  sessionId: string;
  immutableArtifactSha256: string;
  outputProofSha256: string;
  committedAt: string;
  exitCode: 0;
  exitObservedAt: string;
}
const CompletionAttestationSchema = z.object({
  authority: z.literal('trusted_storage_adapter'),
  requestId: z.string().uuid(),
  sessionId: z.string().uuid(),
  immutableArtifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  outputProofSha256: z.string().regex(/^[a-f0-9]{64}$/),
  committedAt: z.string().datetime(),
  exitCode: z.literal(0),
  exitObservedAt: z.string().datetime(),
}).strict();

export interface SupervisorOptions {
  now?: () => number;
  stallAfterMs?: number;
  maxSessions?: number;
}

export interface RetryPolicy {
  /** Unknown or externally side-effecting operations MUST remain manual. */
  effect: 'read_only' | 'idempotent' | 'unknown' | 'side_effecting';
  retryBudget: number;
  attemptsUsed: number;
  ownerApproved: boolean;
  processTerminatedAndReconciled: boolean;
}

export function evaluateRetryPolicy(policy: RetryPolicy): {
  restartAllowed: boolean; reason: string;
} {
  if (!policy.ownerApproved) return { restartAllowed: false, reason: 'OWNER_APPROVAL_REQUIRED' };
  if (!policy.processTerminatedAndReconciled) return { restartAllowed: false, reason: 'PROCESS_RECONCILIATION_REQUIRED' };
  if (policy.effect !== 'read_only' && policy.effect !== 'idempotent') {
    return { restartAllowed: false, reason: 'SIDE_EFFECT_SAFETY_UNKNOWN' };
  }
  if (!Number.isSafeInteger(policy.retryBudget) || policy.retryBudget < 1 ||
      !Number.isSafeInteger(policy.attemptsUsed) || policy.attemptsUsed < 0 ||
      policy.attemptsUsed >= policy.retryBudget) {
    return { restartAllowed: false, reason: 'RETRY_BUDGET_EXHAUSTED' };
  }
  return { restartAllowed: true, reason: 'ELIGIBLE_FOR_EXPLICIT_RESTART' };
}

export class ProgressSupervisor {
  private readonly sessions = new Map<string, SessionProgress>();
  private readonly now: () => number;
  private readonly stallAfterMs: number;
  private readonly maxSessions: number;

  constructor(options: SupervisorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.stallAfterMs = Math.max(1, options.stallAfterMs ?? 30_000);
    this.maxSessions = Math.min(MAX_SESSIONS, Math.max(1, options.maxSessions ?? MAX_SESSIONS));
  }

  get trackedSessionCount(): number { return this.sessions.size; }

  register(sessionId: string, startedMs = this.now()): void {
    if (this.sessions.has(sessionId)) return;
    // Evict only terminal records, never a running job. On saturation, refuse
    // observation rather than allocating unbounded memory or killing a job.
    if (this.sessions.size >= this.maxSessions) {
      for (const [id, item] of this.sessions) {
        if (item.status !== 'running' && item.status !== 'orphaned') {
          this.sessions.delete(id);
          break;
        }
      }
    }
    if (this.sessions.size >= this.maxSessions) return;
    this.sessions.set(sessionId, {
      id: sessionId, status: 'running', exitCode: null, startedMs,
      lastOutputMs: startedMs, invalidRecords: 0, stdoutFragment: '',
      droppingOversizedLine: false, seenWarningCodes: new Set(),
      proofGeneration: 0, pendingReconnect: false, completionAttested: false,
    });
  }

  /** Bind an externally assigned invocation UUID, never from worker output. */
  bindTrustedRequest(sessionId: string, requestId: string): boolean {
    if (!z.string().uuid().safeParse(requestId).success) return false;
    const tracked = this.sessions.get(sessionId);
    if (!tracked || tracked.trustedRequestId && tracked.trustedRequestId !== requestId) return false;
    if (!tracked) return false;
    tracked.trustedRequestId = requestId;
    tracked.proofGeneration++;
    tracked.evidence = undefined;
    tracked.completionAttested = false;
    return true;
  }

  recover(sessions: ReadonlyArray<{ sessionId: string; status: string; startedAt?: string; exitCode?: number | null }>): void {
    for (const session of sessions) {
      this.register(session.sessionId, Number.isFinite(Date.parse(session.startedAt ?? ''))
        ? Date.parse(session.startedAt!) : this.now());
      const tracked = this.sessions.get(session.sessionId);
      if (!tracked) continue;
      if (session.status === 'running' || session.status === 'orphaned' ||
          session.status === 'exited' || session.status === 'lost') {
        const newExitCode = session.exitCode ?? null;
        if (tracked.status !== session.status || tracked.exitCode !== newExitCode) {
          tracked.proofGeneration++;
          tracked.evidence = undefined;
          tracked.completionAttested = false;
        }
        if ((session.status === 'lost' || session.status === 'orphaned') &&
            tracked.status !== session.status) {
          tracked.sample = undefined;
          tracked.lastReportedProgressMs = undefined;
        }
        tracked.status = session.status;
        tracked.exitCode = newExitCode;
      }
    }
  }

  observeProcessEvent(event: { topic: string; data: Record<string, unknown> }): void {
    const id = event.data.sessionId;
    if (typeof id !== 'string') return;
    if (event.topic === 'process.started') {
      this.register(id);
      return;
    }
    const tracked = this.sessions.get(id);
    if (!tracked) return;
    const now = this.now();
    if (event.topic === 'process.exited') {
      tracked.proofGeneration++;
      tracked.evidence = undefined;
      tracked.completionAttested = false;
      tracked.lastProcessExitedAt = typeof event.data.exitedAt === 'string' &&
        Number.isFinite(Date.parse(event.data.exitedAt)) ? event.data.exitedAt :
        new Date(now).toISOString();
      tracked.status = 'exited';
      tracked.exitCode = typeof event.data.exitCode === 'number' ? event.data.exitCode : null;
      return;
    }
    if (event.topic !== 'process.output') return;
    if (event.data.stream !== 'stdout' || typeof event.data.text !== 'string') {
      tracked.lastOutputMs = now;
      return;
    }
    if (typeof event.data.seq === 'number' &&
        (!Number.isSafeInteger(event.data.seq) ||
         event.data.seq <= (tracked.lastOutputSeq ?? 0))) return;
    // A queued pre-reconnect stdout event is NOT new worker activity.
    if (tracked.pendingReconnect) {
      const eventTime = typeof event.data.at === 'string' ? Date.parse(event.data.at) : NaN;
      if (!Number.isFinite(eventTime) ||
          eventTime < (tracked.reconnectAtMs ?? now) ||
          eventTime > now + 2000 ||
          typeof event.data.seq !== 'number') return;
    }
    if (typeof event.data.seq === 'number') tracked.lastOutputSeq = event.data.seq;
    tracked.lastOutputMs = now;
    // Never split/duplicate a possibly multi-megabyte output event in memory.
    // Scan newline boundaries and retain at most MAX_LINE_BYTES per session.
    const chunk = event.data.text;
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf('\n', cursor);
      const end = newline === -1 ? chunk.length : newline;
      const span = end - cursor;
      if (!tracked.droppingOversizedLine) {
        if (span > MAX_LINE_BYTES) {
          tracked.droppingOversizedLine = true;
          tracked.stdoutFragment = '';
        } else {
          const part = chunk.slice(cursor, end);
          if (Buffer.byteLength(tracked.stdoutFragment, 'utf8') +
              Buffer.byteLength(part, 'utf8') > MAX_LINE_BYTES) {
            tracked.droppingOversizedLine = true;
            tracked.stdoutFragment = '';
          } else {
            tracked.stdoutFragment += part;
          }
        }
      }
      if (newline !== -1) {
        if (!tracked.droppingOversizedLine) {
          const raw = tracked.stdoutFragment;
          const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
          if (line.startsWith(PROGRESS_PREFIX)) {
            let parsed: unknown;
            try { parsed = JSON.parse(line.slice(PROGRESS_PREFIX.length)); }
            catch { this.invalid(tracked); parsed = undefined; }
            if (parsed !== undefined) {
              const result = WorkerProgressSchema.safeParse(parsed);
              if (!result.success) this.invalid(tracked);
              else if (this.observeMetrics(id, result.data)) {
                // Hash exact captured stdout record bytes, not an invented
                // string reconstructed from mutable progress counters.
                tracked.lastProgressOutputSha256 = createHash('sha256')
                  .update(raw + '\n', 'utf8').digest('hex');
              }
            }
          }
        }
        tracked.stdoutFragment = '';
        tracked.droppingOversizedLine = false;
        cursor = newline + 1;
      } else {
        break;
      }
    }
  }

  /** Trusted only as a worker report, NOT independently verified completion. */
  observeMetrics(sessionId: string, metrics: WorkerProgress): boolean {
    const result = WorkerProgressSchema.safeParse(metrics);
    const tracked = this.sessions.get(sessionId);
    if (!result.success || !tracked || tracked.status !== 'running') return false;
    const sample = result.data;
    if (tracked.sample &&
        (sample.completed_count < tracked.sample.completed_count ||
         sample.failure_count < tracked.sample.failure_count)) {
      this.invalid(tracked);
      return false;
    }
    const now = this.now();
    if (tracked.lastCompletedCount === undefined ||
        sample.completed_count > tracked.lastCompletedCount) {
      tracked.lastCompletedAdvanceMs = now;
      tracked.growthSinceMs = undefined;
      if (sample.completed_count > 0) tracked.lastReportedProgressMs = now;
    } else if (tracked.lastPendingCount !== undefined) {
      if (sample.pending_count > tracked.lastPendingCount && tracked.growthSinceMs === undefined) {
        tracked.growthSinceMs = now;
      } else if (sample.pending_count < tracked.lastPendingCount) {
        tracked.growthSinceMs = undefined;
      }
    }
    tracked.proofGeneration++;
    tracked.evidence = undefined;
    tracked.completionAttested = false;
    tracked.lastProgressOutputSha256 = undefined;
    tracked.pendingReconnect = false;
    tracked.lastHeartbeatMs = now;
    tracked.lastOutputMs = now;
    tracked.lastCompletedCount = sample.completed_count;
    tracked.lastPendingCount = sample.pending_count;
    tracked.sample = sample;
    if (sample.pending_count === 0) tracked.growthSinceMs = undefined;
    // A new observation can clear old warning de-duplication when work advances.
    if (tracked.lastReportedProgressMs === now) tracked.seenWarningCodes.clear();
    return true;
  }

  /**
   * Agent/Hub socket reconnection is not evidence that a worker has made
   * progress. Invalidate cached reports until the worker emits fresh
   * telemetry; never auto-replay ambiguous operations.
   */
  invalidateOnReconnect(): void {
    for (const tracked of this.sessions.values()) {
      tracked.proofGeneration++;
      tracked.evidence = undefined;
      tracked.completionAttested = false;
      tracked.lastProgressOutputSha256 = undefined;
      if (tracked.status !== 'running') continue;
      tracked.sample = undefined;
      tracked.lastHeartbeatMs = undefined;
      tracked.lastReportedProgressMs = undefined;
      tracked.lastCompletedAdvanceMs = undefined;
      tracked.lastCompletedCount = undefined;
      tracked.lastPendingCount = undefined;
      tracked.growthSinceMs = undefined;
      tracked.stdoutFragment = '';
      tracked.droppingOversizedLine = false;
      tracked.pendingReconnect = true;
      tracked.reconnectAtMs = this.now();
      tracked.seenWarningCodes.clear();
    }
  }

  /**
   * Only the trusted Agent/test harness chooses the result root and expected
   * account/device/project/run/session/total. No paths come from stdout.
   * Actual result files are independently read and rehashed.
   */
  async verifySessionFromDisk(
    sessionId: string, request: ProgressProofRequest,
    attestation?: TrustedCompletionAttestation,
  ): Promise<ProgressProofReport> {
    const tracked = this.sessions.get(sessionId);
    const unverified = (reason: string): ProgressProofReport => ({
      status: 'unverified', reason, completedCount: null,
      pendingCount: null, failureCount: null, artifactSha256: null,
      sealed: false, verifiedAt: null, lastArtifactModifiedAt: null,
    });
    if (!tracked || !tracked.sample || tracked.status === 'lost' ||
        tracked.status === 'orphaned' ||
        request.scope.sessionId !== sessionId) {
      return unverified('NO_TRUSTED_LIVE_SAMPLE');
    }
    const generation = tracked.proofGeneration;
    const status = tracked.status;
    const sample = tracked.sample;
    const report = await verifyResultFiles(request, this.now);
    if (tracked.proofGeneration !== generation || tracked.status !== status ||
        tracked.sample !== sample) {
      return unverified('PROOF_RACE_REVERIFY');
    }
    if (report.status === 'verified' &&
        (report.completedCount !== sample.completed_count ||
         report.pendingCount !== sample.pending_count ||
         report.failureCount !== sample.failure_count ||
         !sample.result_artifact_sha256 ||
         report.artifactSha256 !== sample.result_artifact_sha256 ||
         // A result modified well after the Agent observed claimed progress
         // cannot retrospectively validate that earlier stdout claim.
         (report.completedCount > 0 && tracked.lastReportedProgressMs !== undefined &&
          report.lastArtifactModifiedAt !== null &&
          Date.parse(report.lastArtifactModifiedAt) > tracked.lastReportedProgressMs + 2000))) {
      tracked.evidence = unverified('WORKER_REPORT_MISMATCH');
    } else {
      tracked.evidence = report;
    }
    tracked.completionAttested = false;
    if (tracked.evidence.status === 'verified' && attestation) {
      const parsed = CompletionAttestationSchema.safeParse(attestation);
      const at = parsed.success ? parsed.data : null;
      const committedAt = at ? Date.parse(at.committedAt) : NaN;
      const exitObservedAt = tracked.lastProcessExitedAt === undefined ?
        NaN : Date.parse(tracked.lastProcessExitedAt);
      const proofAt = tracked.evidence.verifiedAt === null ?
        NaN : Date.parse(tracked.evidence.verifiedAt);
      if (!at || !tracked.trustedRequestId ||
          at.requestId !== tracked.trustedRequestId ||
          at.sessionId !== sessionId ||
          at.immutableArtifactSha256 !== tracked.evidence.artifactSha256 ||
          at.outputProofSha256 !== tracked.lastProgressOutputSha256 ||
          tracked.status !== 'exited' || tracked.exitCode !== 0 ||
          at.exitObservedAt !== tracked.lastProcessExitedAt ||
          !Number.isFinite(committedAt) ||
          !Number.isFinite(exitObservedAt) || !Number.isFinite(proofAt) ||
          committedAt < tracked.startedMs - 2_000 ||
          committedAt > exitObservedAt + 2_000 ||
          committedAt > proofAt + 2_000 ||
          exitObservedAt > proofAt + 2_000) {
        tracked.evidence = unverified('TRUSTED_COMPLETION_CORRELATION_MISMATCH');
      } else {
        tracked.completionAttested = true;
      }
    }
    return tracked.evidence;
  }

  private invalid(tracked: SessionProgress): void {
    tracked.proofGeneration++;
    tracked.evidence = undefined;
    tracked.completionAttested = false;
    tracked.invalidRecords = Math.min(65535, tracked.invalidRecords + 1);
    // Rejected records do not update heartbeat, work counts or proof timestamps.
  }

  snapshot(sessionId: string): Record<string, unknown> {
    const tracked = this.sessions.get(sessionId);
    if (!tracked) return {
      state: 'progress_unknown', telemetrySource: 'none',
      progressVerified: false, lastVerifiedProgressAt: null,
      completionEvidence: 'none', restartAllowed: false,
    };
    const now = this.now();
    const sample = tracked.sample;
    const freshProof = tracked.evidence?.status === 'verified' &&
      tracked.evidence.verifiedAt !== null &&
      now - Date.parse(tracked.evidence.verifiedAt) >= 0 &&
      now - Date.parse(tracked.evidence.verifiedAt) <= MAX_PROOF_AGE_MS;
    let state: ProgressState = 'progress_unknown';
    if (tracked.status === 'lost' || tracked.status === 'orphaned') state = 'lost';
    else if (tracked.status === 'exited' && tracked.exitCode !== null && tracked.exitCode !== 0) {
      state = 'failed';
    } else if (tracked.evidence?.status === 'unverified') {
      state = tracked.evidence.reason === 'PROOF_UNAVAILABLE' ? 'progress_unknown' : 'progress_mismatch';
    }
    else if (tracked.status === 'exited') {
      state = (tracked.exitCode !== null && tracked.exitCode !== 0) || (sample?.failure_count ?? 0) > 0 ? 'failed'
        : tracked.exitCode === 0 && sample && sample.pending_count === 0
          ? 'reported_complete' : 'incomplete';
    } else if (sample) {
      state = this.stalled(tracked, now) ? 'stalled' : 'active';
    }
    if (freshProof && tracked.completionAttested && tracked.evidence && tracked.status === 'exited' &&
        tracked.exitCode === 0 && tracked.evidence.sealed &&
        tracked.evidence.pendingCount === 0 && tracked.evidence.failureCount === 0) {
      state = 'completed_verified';
    }
    return {
      state,
      processState: tracked.status,
      telemetrySource: sample ? 'worker_stdout_self_reported' : 'none',
      completedCount: sample?.completed_count ?? null,
      pendingCount: sample?.pending_count ?? null,
      failureCount: sample?.failure_count ?? null,
      heartbeatAt: tracked.lastHeartbeatMs === undefined ? null : new Date(tracked.lastHeartbeatMs).toISOString(),
      lastReportedProgressAt: tracked.lastReportedProgressMs === undefined ? null : new Date(tracked.lastReportedProgressMs).toISOString(),
      lastVerifiedProgressAt: freshProof ? tracked.evidence!.verifiedAt : null,
      progressVerified: freshProof,
      completionAttested: freshProof && tracked.completionAttested,
      requestIdCorrelated: freshProof && tracked.completionAttested ? tracked.trustedRequestId : null,
      outputProofSha256: freshProof && tracked.completionAttested ? tracked.lastProgressOutputSha256 : null,
      verificationReasonForCompletion: freshProof && !tracked.completionAttested ? 'IMMUTABLE_ATTESTATION_REQUIRED' : null,
      verifiedCompletedCount: freshProof ? tracked.evidence!.completedCount : null,
      verifiedPendingCount: freshProof ? tracked.evidence!.pendingCount : null,
      verifiedFailureCount: freshProof ? tracked.evidence!.failureCount : null,
      resultArtifactSha256Verified: freshProof ? tracked.evidence!.artifactSha256 : null,
      lastArtifactModifiedAt: freshProof ? tracked.evidence!.lastArtifactModifiedAt : null,
      verificationReason: tracked.evidence?.status === 'verified' && !freshProof ?
        'DISK_PROOF_STALE_REVERIFY' : tracked.evidence?.reason ?? (tracked.pendingReconnect ? 'RECONNECT_REVERIFY_REQUIRED' : 'PROOF_NOT_ATTEMPTED'),
      resultArtifactSha256Reported: sample?.result_artifact_sha256 ?? null,
      completionEvidence: freshProof ?
        'result_files_rehashed_scope_bound' : sample ? 'self_reported_unverified' : 'none',
      diagnosis: sample?.diagnosis ?? 'unknown',
      invalidTelemetryCount: tracked.invalidRecords,
      restartAllowed: false,
    };
  }

  private stalled(item: SessionProgress, now: number): boolean {
    if (!item.sample || item.status !== 'running') return false;
    const anchor = item.lastCompletedAdvanceMs ?? item.startedMs;
    return now - anchor >= this.stallAfterMs;
  }

  /** Side-effect free evaluation, de-duplicated warning emissions, no kill/restart. */
  scan(): ProgressWarning[] {
    const now = this.now();
    const warnings: ProgressWarning[] = [];
    for (const item of this.sessions.values()) {
      let code: ProgressWarningCode | undefined;
      let certainty: ProgressWarning['certainty'] = 'observed';
      let action = 'Inspect worker logs and progress artifacts; do not blindly retry.';
      if (item.status === 'exited' && item.exitCode !== null && item.exitCode !== 0) {
        code = 'PROCESS_EXITED_FAILED';
      } else if (item.evidence?.status === 'verified' && item.evidence.verifiedAt !== null &&
          now - Date.parse(item.evidence.verifiedAt) > MAX_PROOF_AGE_MS) {
        code = 'DISK_PROOF_STALE';
      } else if (item.evidence?.status === 'unverified' && item.evidence.reason !== 'PROOF_UNAVAILABLE') {
        code = 'EVIDENCE_MISMATCH';
      } else if (item.pendingReconnect && item.status === 'running') {
        code = 'RECONNECT_PROOF_EXPIRED';
        certainty = 'observed';
      } else if (item.status === 'exited' && ((item.exitCode !== null && item.exitCode !== 0) || (item.sample?.failure_count ?? 0) > 0)) {
        code = 'PROCESS_EXITED_FAILED';
        if (item.exitCode === 0) certainty = 'worker_reported';
      } else if (item.status === 'exited' && (item.exitCode === null || !item.sample || item.sample.pending_count !== 0)) {
        code = 'PROCESS_EXITED_INCOMPLETE';
      } else if (item.status !== 'running') continue;
      // Observed self-reported counter stagnation remains visible when a worker
      // self-reports rate limiting or resource saturation. Report that
      // diagnosis separately; it is not an independent root-cause proof.
      else if (item.sample && this.stalled(item, now)) {
        code = item.growthSinceMs !== undefined &&
          now - item.growthSinceMs >= this.stallAfterMs
          ? 'QUEUE_GROWING_WITHOUT_COMPLETIONS' : 'NO_COMPLETIONS';
        certainty = 'suspected';
      } else if (item.sample?.diagnosis && item.sample.diagnosis !== 'none') {
        code = 'WORKER_REPORTED_BLOCKER';
        certainty = 'worker_reported';
        action = 'Examine worker-reported blocker; independently check host/network telemetry.';
      } else if (item.sample && item.lastHeartbeatMs !== undefined &&
                 now - item.lastHeartbeatMs >= this.stallAfterMs) {
        code = 'HEARTBEAT_STALE';
      } else if (now - item.lastOutputMs >= this.stallAfterMs) {
        code = item.sample ? 'OUTPUT_STALLED' : 'PROGRESS_UNKNOWN';
        certainty = 'suspected';
      }
      if (!code && item.invalidRecords > 0) code = 'INVALID_TELEMETRY';
      if (!code || item.seenWarningCodes.has(code)) continue;
      item.seenWarningCodes.add(code);
      warnings.push({
        sessionId: item.id, code, at: new Date(now).toISOString(),
        diagnosis: item.sample?.diagnosis ?? 'unknown', certainty,
        restartAllowed: false, action,
      });
    }
    return warnings;
  }
}
