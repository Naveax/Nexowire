import {classifyFailure, type FailureAttributionV2} from './error-contract-v2.js';

/** Trusted CLIENT observation only, never derived from Hub message text. */
export type ClientToolInterruptionKind = 'tool_refusal_observed' | 'call_budget_exhausted';
export interface ClientToolInterruption {
  readonly kind: ClientToolInterruptionKind;
  /** A not-delivered claim requires independent client-side submission evidence. */
  readonly delivery: 'confirmed_not_delivered' | 'confirmed_delivered' | 'unknown';
  readonly readOnly: boolean;
  readonly correlationId?: string;
  readonly operationId?: string;
}

/** This diagnoses client failures; it cannot increase host limits or allow denied tools. */
export function classifyClientToolInterruption(
  observation: ClientToolInterruption,
): FailureAttributionV2 {
  if (observation.kind !== 'tool_refusal_observed' &&
      observation.kind !== 'call_budget_exhausted') {
    throw new Error('CLIENT_TOOL_INTERRUPTION_KIND_INVALID');
  }
  if (observation.delivery !== 'confirmed_not_delivered' &&
      observation.delivery !== 'confirmed_delivered' &&
      observation.delivery !== 'unknown') {
    throw new Error('CLIENT_TOOL_DELIVERY_EVIDENCE_INVALID');
  }
  if (typeof observation.readOnly !== 'boolean') {
    throw new Error('CLIENT_TOOL_EFFECT_CLASS_INVALID');
  }
  return classifyFailure({
    code: observation.kind === 'call_budget_exhausted'
      ? 'UPSTREAM_TOOL_CALL_BUDGET_EXHAUSTED'
      : 'UPSTREAM_TOOL_REFUSAL_OBSERVED',
    observedAt: 'upstream_client',
    dispatched: observation.delivery === 'confirmed_not_delivered'
      ? false : observation.delivery === 'confirmed_delivered' ? true : 'unknown',
    readOnly: observation.readOnly,
    ...(observation.correlationId ? {correlationId: observation.correlationId} : {}),
    ...(observation.operationId ? {operationId: observation.operationId} : {}),
  });
}

/**
 * A payload-free, source-only progress record. The caller must persist and
 * authenticate this record. This is NOT durable storage, a signed effect
 * receipt, external CAS, a grant or native-dispatch authority.
 */
export interface ToolWorkflowStep {
  readonly stepId: string;
  readonly originalRequestId: string;
  readonly fingerprintSha256: string;
  readonly effect: 'read_only' | 'mutation';
  readonly status: 'pending' | 'completed' | 'blocked' | 'unknown';
  /** Caller-observed digest only; NOT a trusted effect or publication receipt. */
  readonly completionDigestSha256?: string;
}
export interface ToolWorkflowCheckpoint {
  readonly version: 1;
  readonly workflowId: string;
  readonly steps: readonly ToolWorkflowStep[];
}
export interface ToolBatchPlan {
  readonly status: 'READY' | 'CALL_BUDGET_EXHAUSTED' | 'NO_SAFE_READS';
  readonly selected: readonly string[];
  readonly deferredReadOnly: readonly string[];
  readonly requireExternalAdmission: readonly string[];
  readonly blocked: readonly string[];
  readonly unresolved: readonly string[];
  readonly completed: readonly string[];
  readonly maxCalls: number;
  readonly reservedCalls: number;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
function validId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}
/** Never infer a completed operation from a missing or corrupt checkpoint. */
export function validateToolWorkflowCheckpoint(value: ToolWorkflowCheckpoint): void {
  if (!value || value.version !== 1 || !validId(value.workflowId) ||
      !Array.isArray(value.steps) || value.steps.length > 1024) {
    throw new Error('TOOL_WORKFLOW_CHECKPOINT_INVALID');
  }
  const seen = new Set<string>();
  for (const step of value.steps) {
    if (!step || !validId(step.stepId) || !validId(step.originalRequestId) ||
        !SHA256.test(step.fingerprintSha256) ||
        (step.effect !== 'read_only' && step.effect !== 'mutation') ||
        !['pending', 'completed', 'blocked', 'unknown'].includes(step.status) ||
        seen.has(step.stepId)) {
      throw new Error('TOOL_WORKFLOW_STEP_INVALID');
    }
    seen.add(step.stepId);
    if (step.status === 'completed' ? !SHA256.test(step.completionDigestSha256 ?? '')
      : step.completionDigestSha256 !== undefined) {
      throw new Error('TOOL_WORKFLOW_COMPLETION_EVIDENCE_INVALID');
    }
  }
}
/**
 * Plan pending READ-ONLY observations inside a finite call budget.
 * Completed work is not requeued; refused/unknown work is never replayed.
 * Mutations always need an independently verified admission provider.
 * This planner does not execute, retry or authorize tools.
 */
export function planToolWorkflowContinuation(
  checkpoint: ToolWorkflowCheckpoint,
  options: {readonly maxCalls: number; readonly reserveCalls?: number},
): ToolBatchPlan {
  validateToolWorkflowCheckpoint(checkpoint);
  const {maxCalls, reserveCalls = 0} = options;
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 0 || maxCalls > 256 ||
      !Number.isSafeInteger(reserveCalls) || reserveCalls < 0 || reserveCalls > 256) {
    throw new Error('TOOL_CALL_BUDGET_INVALID');
  }
  const slots = Math.max(0, maxCalls - reserveCalls);
  const pendingReadOnly = checkpoint.steps.filter(step =>
    step.status === 'pending' && step.effect === 'read_only');
  const selected = pendingReadOnly.slice(0, slots).map(step => step.stepId);
  const deferredReadOnly = pendingReadOnly.slice(slots).map(step => step.stepId);
  const requireExternalAdmission = checkpoint.steps.filter(step =>
    step.status === 'pending' && step.effect === 'mutation').map(step => step.stepId);
  const blocked = checkpoint.steps.filter(step => step.status === 'blocked').map(step => step.stepId);
  const unresolved = checkpoint.steps.filter(step => step.status === 'unknown').map(step => step.stepId);
  const completed = checkpoint.steps.filter(step => step.status === 'completed').map(step => step.stepId);
  return Object.freeze({
    status: selected.length ? 'READY'
      : pendingReadOnly.length && slots === 0 ? 'CALL_BUDGET_EXHAUSTED' : 'NO_SAFE_READS',
    selected: Object.freeze(selected),
    deferredReadOnly: Object.freeze(deferredReadOnly),
    requireExternalAdmission: Object.freeze(requireExternalAdmission),
    blocked: Object.freeze(blocked),
    unresolved: Object.freeze(unresolved),
    completed: Object.freeze(completed),
    maxCalls, reservedCalls: reserveCalls,
  });
}
