# #45 Immutable task evidence projection: source-only read contract

Scope: new src/coding/task-evidence-projection.ts and independent TEMP
negative QA. No edits to #11 Progress, #29 Audit, #01 Journal, live Agent,
production D1, protected Broker, WSS, CI workflow or installed service.

## Threat boundary

- The caller must supply scope from an authenticated, device-authorized task
  grant and viewer from the authenticated session. A caller-provided owner
  string is NOT authentication. Enforce authorization before fetching evidence.
- logicalMutationId is the immutable logical effect identity, separate from
  requestId and any local session/runbook ID. sourceSha, worktree and both
  epochs must match exactly in any receipt/CAS claim. Do not infer journal
  owner/device from a requestId alone; Agent journal v1 does not bind these.
- AuditLog rows have an operationId and targetId but no trusted owner,
  task, source SHA, signed issuer receipt or external CAS. Counts are
  untrusted diagnostics, filtered to explicitly pinned auditOperationId and
  deviceId. No diagnostic string from a row is ever exported.
- #11 worker stdout/progress is not native execution proof. completed_verified
  in a serialized report remains UNTRUSTED_REPORT here.
- All incoming receipt/CAS objects are **unverified serialized claims**, even
  when they contain signature, verified:true, status committed, or a forged
  completed result. A real issuer verifier must validate canonical signed
  payload, pinned public-key registry and revocation/current issuer epoch;
  a physically independent external CAS readback must prove current owner
  epoch, commit identity and revoke-start atomic ordering.
- This projection intentionally **never** emits COMPLETED_VERIFIED,
  CORE EFFECTIVE, mayDispatch:true or permission to replay UNKNOWN. It is
  a diagnostic adapter, not an authorization source or effect executor.
- No raw command, payload, stdout, stderr, credentials, signature, audit
  message or CAS private bytes enter the export. Only trusted pinned identity,
  fixed status/classification enums and filtered per-status counters appear.

## Handoff / physical NO-GO

Requires independent verification adapters from #29/#01/#08 and a protected
external CAS provider; integration must still read current owner/device
revocation state at effect time and bind exact requestId + logicalMutationId,
issuer receipt, source SHA and worktree identity. This source-only PR includes
no installed Agent/Broker, physical Windows receipt, real two-Hub CAS, D1,
cloud publication, or end-to-end telemetry UI. None is claimed PASS.
