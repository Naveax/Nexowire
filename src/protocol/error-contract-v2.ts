/**
 * Error Contract v2. This is attribution of OBSERVABLE evidence, not a claim
 * to know an upstream provider's private policy or a remote operation's outcome.
 * Additive to the v1 MCP and Agent protocols.
 */
export type FailureLayer =
  | 'upstream_client' | 'mcp_hub' | 'identity' | 'device_connection'
  | 'native_agent' | 'windows_wsl' | 'operation' | 'task_verification'
  | 'undetermined';

export type DispatchState = 'not_dispatched' | 'dispatched' | 'unknown';
export type RetrySafety =
  | 'read_only_retry' | 'after_reauthorization'
  | 'reconcile_first' | 'manual_review';

export interface FailureAttributionV2 {
  contractVersion: 2;
  /** Where a failure was actually observed; does not imply root cause. */
  observedAt: FailureLayer;
  /** Inferred ONLY from a known, authoritative public code or direct evidence. */
  causeLayer: FailureLayer;
  certainty: 'confirmed' | 'unknown';
  code: string;
  dispatchState: DispatchState;
  retrySafety: RetrySafety;
  nextAction: string;
  correlationId?: string;
  operationId?: string;
}

export interface FailureEvidence {
  code: string;
  observedAt: FailureLayer;
  dispatched?: boolean | 'unknown';
  readOnly?: boolean;
  correlationId?: string;
  operationId?: string;
}

/** Scrub secrets from diagnostic strings. Not an encryption/storage boundary. */
export function redactDiagnosticText(value: string): string {
  return value
    .replace(/-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]* )?PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(["'](?:password|passwd|secret|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key)["']\s*:\s*["'])([^"']+)(["'])/gi, '$1[REDACTED]$3')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, '[REDACTED TOKEN]')
    .replace(/((?:password|passwd|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)\s*[:=]\s*["']?)([^\s,;"'&}]+)/gi, '$1[REDACTED]')
    .replace(/([?&](?:api_key|token|access_token|refresh_token|password|secret)=)[^&#\s]+/gi, '$1[REDACTED]');
}

const sensitiveKey = /^(?:password|password_hash|passwd|secret|client_?secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|bearer[_-]?token|api[_-]?key|private[_-]?key|authorization|credential|credentials)$/i;

/**
 * Recursively produce a redacted copy for MCP JSON responses/audit metadata.
 * Opaque image/byte content is never decoded. Circular data fails closed.
 */
export function redactDiagnosticValue(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const visit = (input: unknown, depth: number): unknown => {
    if (typeof input === 'string') return redactDiagnosticText(input);
    if (!input || typeof input !== 'object') return input;
    if (depth > 24 || seen.has(input)) return '[REDACTED UNINSPECTABLE DATA]';
    seen.add(input);
    const result = Array.isArray(input)
      ? input.map(item => visit(item, depth + 1))
      : Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, entry]) => [
          key,
          sensitiveKey.test(key) ? '[REDACTED]' : visit(entry, depth + 1),
        ]));
    seen.delete(input); // shared references are not cycles
    return result;
  };
  return visit(value, 0);
}

function publicCode(code: string): string {
  return /^[A-Za-z][A-Za-z0-9_]{0,95}$/.test(code) ? code : 'UNCLASSIFIED_ERROR';
}

/**
 * No heuristic based on message prose: it can contain untrusted text, and a
 * provider refusal BEFORE MCP submission is invisible to Nexowire.
 */
export function classifyFailure(evidence: FailureEvidence): FailureAttributionV2 {
  const code = publicCode(evidence.code);
  const observedAt = evidence.observedAt;
  let causeLayer: FailureLayer = 'undetermined';
  let certainty: FailureAttributionV2['certainty'] = 'unknown';
  let nextAction = 'Inspect the correlated component logs and verify actual state before retrying.';
  let retrySafety: RetrySafety = evidence.readOnly ? 'read_only_retry' : 'manual_review';
  const dispatchState: DispatchState = evidence.dispatched === true ? 'dispatched'
    : evidence.dispatched === false ? 'not_dispatched' : 'unknown';

  if (code === 'MUTATION_STATE_UNKNOWN' || code === 'IDEMPOTENCY_STATE_UNKNOWN' ||
      code === 'AGENT_OPERATION_COMPLETION_UNCONFIRMED' ||
      code === 'AGENT_OPERATION_ALREADY_RECORDED') {
    nextAction = 'Query the original operation ID and read back the target state; never blindly replay the mutation.';
    retrySafety = 'reconcile_first';
  } else if (code === 'AGENT_OFFLINE' || code === 'AGENT_DISCONNECTED' ||
             code === 'AGENT_RECONNECT_TIMEOUT' || code === 'AGENT_INSTANCE_CHANGED' ||
             code === 'AGENT_CAPABILITY_CHANGED') {
    causeLayer = 'device_connection';
    certainty = 'confirmed'; // confirms the observed connection failure, not why it disconnected
    nextAction = 'Check target device and Agent connectivity. Reconcile mutations before any retry.';
  } else if (code === 'PATH_DENIED' || code === 'AGENT_PATH_DENIED') {
    causeLayer = 'native_agent';
    certainty = 'confirmed';
    nextAction = 'Inspect the explicit Agent path grant. Ask the owner for a scoped grant; do not switch to shell to bypass it.';
    retrySafety = 'after_reauthorization';
  } else if (code === 'AuthRequiredError' || code === 'AUTH_REQUIRED' ||
             code === 'UNAUTHORIZED' || code === 'AUTHENTICATION_REQUIRED') {
    causeLayer = 'identity';
    certainty = 'confirmed';
    nextAction = 'Check the exact OAuth client, credential scope and login flow. Reauthorize using the official provider flow.';
    retrySafety = 'after_reauthorization';
  } else if (code === 'UAC_DENIED' || code === 'WINDOWS_UAC_DENIED' ||
             code === 'ELEVATION_DENIED') {
    causeLayer = 'windows_wsl';
    certainty = 'confirmed';
    nextAction = 'Request the legitimate Windows elevation/owner-consent workflow; do not bypass UAC.';
    retrySafety = 'after_reauthorization';
  } else if (code === 'SHELL_EXIT_NONZERO') {
    causeLayer = 'operation';
    certainty = 'confirmed'; // exit was confirmed; meaning/root cause of exit is not
    nextAction = 'Inspect redacted stderr, command exit status, and application-specific postconditions.';
  } else if (code === 'TASK_VERIFICATION_FAILED') {
    causeLayer = 'task_verification';
    certainty = 'confirmed';
    nextAction = 'Recheck the independent postcondition and its evidence; transport success is not task acceptance.';
  } else if (code === 'SHELL_TASK_TIMED_OUT' || code === 'SHELL_TASK_OUTCOME_UNKNOWN' ||
             code === 'AGENT_TIMEOUT' ||
             code === 'TIMEOUT' || code === 'ETIMEDOUT') {
    nextAction = 'Check whether the original operation is still running or had side effects before retrying.';
  } else if (code === 'UNAVAILABLE' || code === 'PROVIDER_UNHEALTHY' ||
             code === 'PROVIDER_EXECUTION_FAILED') {
    nextAction = 'Check Hub, provider and target health independently; source is not proven from this code alone.';
  } else if (code === 'MCP_AUTHORIZATION_DENIED' ||
             code === 'MCP_TARGET_NOT_AUTHORIZED' ||
             code === 'DEVICE_SELECTION_REQUIRED') {
    causeLayer = 'mcp_hub';
    certainty = 'confirmed';
    nextAction = 'Select an explicitly authorized device or request the missing scoped MCP permission.';
    retrySafety = 'after_reauthorization';
  } else if (code === 'UPSTREAM_REFUSAL_NOT_DELIVERED' &&
             observedAt === 'upstream_client' && dispatchState === 'not_dispatched') {
    causeLayer = 'upstream_client';
    certainty = 'confirmed'; // delivery evidence only, NOT the refusal's private rationale
    nextAction = 'Inspect the provider-visible refusal and use an allowed, transparent workflow. Nexowire cannot diagnose unseen policy decisions.';
  }
  // No observed denial, not even UAC or PATH_DENIED, proves absence of
  // side effects when delivery is unknown. Reconcile BEFORE fresh authority.
  if (!evidence.readOnly && dispatchState !== 'not_dispatched') {
    retrySafety = 'reconcile_first';
  }
  return {
    contractVersion: 2, observedAt, causeLayer, certainty, code,
    dispatchState, retrySafety, nextAction,
    ...(evidence.correlationId ? {correlationId: redactDiagnosticText(evidence.correlationId)} : {}),
    ...(evidence.operationId ? {operationId: redactDiagnosticText(evidence.operationId)} : {}),
  };
}

/** Explicit external evidence only: the Hub cannot self-detect unseen refusals. */
export function classifyUndeliveredUpstreamRefusal(correlationId?: string): FailureAttributionV2 {
  return classifyFailure({
    code: 'UPSTREAM_REFUSAL_NOT_DELIVERED',
    observedAt: 'upstream_client', dispatched: false,
    ...(correlationId ? {correlationId} : {}),
  });
}
