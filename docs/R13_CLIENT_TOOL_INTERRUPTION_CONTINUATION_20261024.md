# R13 | Client tool interruption and bounded continuation (source-only)

## Problem
On 2026-10-24 an authorized user observed a host tool refusal followed by
a Code Mode maximum-call exhaustion while reading 13 independent chat tabs.
The client had already collected several read-only results. Neither error
demonstrates that the Nexowire Agent refused the tool or that MCP delivery
was skipped. Upstream host safety controls and host call budgets are outside
Nexowire's authority.

## Source changes
- Error Contract v2 recognizes two explicitly CLIENT-observed categories:
  UPSTREAM_TOOL_REFUSAL_OBSERVED and UPSTREAM_TOOL_CALL_BUDGET_EXHAUSTED.
  They do not guess private policy details, change existing v1 responses, or
  conflate call budgets with tenant/device quota.
- classifyClientToolInterruption requires a structured delivery observation.
  Only an independently instrumented trusted client may report
  confirmed_not_delivered. No message-text string-matching.
- planToolWorkflowContinuation accepts a bounded payload-free progress
  checkpoint and returns a side-effect-free, budgeted selection of pending
  READ-ONLY observations. Completed, blocked and UNKNOWN steps remain
  separate. Mutating steps always require an external admission authority.

## Integration contract (NOT implemented by this source-only PR)
The first-party client/work coordinator must capture a durable, authenticated
checkpoint before/after each tool call and periodically persist the
fingerprint, originalRequestId, result digest and result state. A provider
refusal must be recorded as BLOCKED, never hidden/re-encoded for replay.
An unknown mutating result requires original-operation reconciliation before
any replay. Client tools must enforce the model's platform-specific call
budget; this library cannot read or raise that budget. The planner never
executes a tool and is NOT a durable journal, external CAS, signed effect
receipt or OS permission.

## Console control
Physical visible-desktop control has a separate local 1..60 minute approval
in src/agent/windows-console-grant.ts. FULL/ROOT/CORE does not automatically
make it 24/7. A future unattended mode needs a separate explicit on-device
enrollment, exact owner/device/session scope, emergency local revocation,
screen lock/secure-desktop exclusions and auditable effect control. Do NOT
silently convert expiring grants into permanent grants or bypass UAC.

## Evidence and acceptance
- 13-step fixture with 3 completed results: never reschedule those three.
- maxCalls=5/reserveCalls=2 yields only 3 pending read-only actions.
- Zero available slots preserves the remaining pending steps intact.
- Refused and UNKNOWN steps cannot enter the automatic read-only batch.
- Corrupt/duplicated/fabricated completion checkpoints fail closed.
- Client-side budget exhaustion has a distinct upstream_client attribution,
  while delivery-unknown native effects require reconciliation.

No actual Firefox automation, OpenAI safety override, host budget increase,
physical console grant, live Agent operation or production deployment is
performed by this change.
