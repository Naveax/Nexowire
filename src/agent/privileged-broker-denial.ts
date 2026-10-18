/**
 * Stable, redacted device-side Broker denial diagnostics.
 * No caller may convert these diagnostics into an elevation fallback.
 * Raw PowerShell stderr may contain path/user details and is never returned.
 */
export type BrokerDenialCode =
  | 'BROKER_OWNER_CONFIRMATION_REQUIRED'
  | 'BROKER_WINDOWS_ELEVATION_REQUIRED'
  | 'BROKER_OS_ACCESS_DENIED_UNATTRIBUTED'
  | 'BROKER_CANONICAL_TASK_REQUIRED'
  | 'BROKER_PROTECTED_SOURCE_REQUIRED'
  | 'BROKER_TASK_IDENTITY_UNVERIFIED'
  | 'BROKER_TASK_TRANSITION_UNVERIFIED'
  | 'BROKER_MODE_INVALID'
  | 'BROKER_ACCESS_FAILURE_UNCLASSIFIED';

export interface BrokerDenialExplanation {
  readonly code: BrokerDenialCode;
  readonly boundary: 'owner' | 'windows-token' | 'task-identity' |
    'source-integrity' | 'task-postcondition' | 'input' | 'unknown';
  readonly requiredPermission: string;
  readonly safeNextAction: string;
  readonly retrySafe: false;
  readonly elevatedFallbackAllowed: false;
}

export function explainPrivilegedBrokerDenial(error: unknown): BrokerDenialExplanation {
  const raw = error instanceof Error ? error.message : '';
  let details: Omit<BrokerDenialExplanation, 'retrySafe' | 'elevatedFallbackAllowed'>;
  if (/BROKER_MODE_CONFIRMATION_REQUIRED/.test(raw)) {
    details = {
      code:'BROKER_OWNER_CONFIRMATION_REQUIRED',
      boundary:'owner',
      requiredPermission:'Explicit local owner confirmation',
      safeNextAction:'Request a fresh owner-approved intent; do not replay a stale approval.',
    };
  } else if (/BROKER_MODE_LOCAL_ELEVATION_REQUIRED|UAC_CANCELLED/i.test(raw)) {
    details = {
      code:'BROKER_WINDOWS_ELEVATION_REQUIRED',
      boundary:'windows-token',
      requiredPermission:'Elevated Windows admin token with explicit OS/UAC approval',
      safeNextAction:'Ask the physical device owner to authorize elevation through the normal Windows flow; do not invoke a separate elevated channel.',
    };
  } else if (/Access is denied|Requested operation requires elevation/i.test(raw)) {
    details = {
      code:'BROKER_OS_ACCESS_DENIED_UNATTRIBUTED',
      boundary:'unknown',
      requiredPermission:'Unverified Windows task ACL, integrity level or user approval',
      safeNextAction:'Inspect the local Windows task and UAC event logs read-only; do not assume administrator approval would resolve the failure.',
    };
  } else if (/BROKER_MODE_NONCANONICAL_TASK_DENIED|BROKER_TASK_ACTION_COUNT_MISMATCH|BROKER_TASK_ACTION_MISMATCH|BROKER_TASK_OWNER_MISMATCH|BROKER_TASK_PRINCIPAL_MISMATCH/.test(raw)) {
    details = {
      code:'BROKER_CANONICAL_TASK_REQUIRED',
      boundary:'task-identity',
      requiredPermission:'Verified canonical scheduled-task identity and owner',
      safeNextAction:'Audit the signed installation and task principal without changing services.',
    };
  } else if (/PRIVILEGED_.*(ACL|SOURCE|ROOT|TRUST)|BROKER_.*(ACL|SOURCE|TRUST)/.test(raw)) {
    details = {
      code:'BROKER_PROTECTED_SOURCE_REQUIRED',
      boundary:'source-integrity',
      requiredPermission:'Administrator-protected Broker executable/import tree',
      safeNextAction:'Complete the separate P0 protected-runtime ACL acceptance before enabling the Broker.',
    };
  } else if (/BROKER_MODE_OFF_NOT_VERIFIED|BROKER_MODE_RUNNING_NOT_VERIFIED/.test(raw)) {
    details = {
      code:'BROKER_TASK_TRANSITION_UNVERIFIED',
      boundary:'task-postcondition',
      requiredPermission:'Independent task/process/port and authenticated-health postcondition',
      safeNextAction:'Inspect task state and Broker health without assuming the requested transition succeeded.',
    };
  } else if (/BROKER_MODE_INVALID/.test(raw)) {
    details = {
      code:'BROKER_MODE_INVALID',
      boundary:'input',
      requiredPermission:'A supported AUTO/ON/OFF mode',
      safeNextAction:'Correct the requested mode; do not execute a command.',
    };
  } else {
    details = {
      code:'BROKER_ACCESS_FAILURE_UNCLASSIFIED',
      boundary:'unknown',
      requiredPermission:'Unknown; authorization or task result was not established',
      safeNextAction:'Collect a local read-only diagnostic with correlation ID; do not blindly retry mutations.',
    };
  }
  return Object.freeze({...details,retrySafe:false,elevatedFallbackAllowed:false});
}

export class PrivilegedBrokerModeDeniedError extends Error {
  readonly code: BrokerDenialCode;
  readonly authorizationExplain: BrokerDenialExplanation;
  constructor(error: unknown) {
    const explain = explainPrivilegedBrokerDenial(error);
    super(explain.code);
    this.name = 'PrivilegedBrokerModeDeniedError';
    this.code = explain.code;
    this.authorizationExplain = explain;
  }
}
