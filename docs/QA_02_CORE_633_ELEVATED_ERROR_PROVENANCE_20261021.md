# #02 independent elevated Error Contract negative QA on #633 source

Date: 2026-10-21. Repo Naveax/Nexowire. Parent Windows Job / broad CORE/ROOT source owner #03: DRAFT [#633](https://github.com/Naveax/Nexowire/pull/633) exact HEAD `c429ed9c7eb6de45c4c1ae8de67b528f940fe3ab`. This QA is an **independent source-only child**, not a change to owner implementation or production.

## Real CI diagnosis: parent #618 vs #633

- [#618 exact HEAD 4e66122 CI #39610514919](https://github.com/Naveax/Nexowire/actions/runs/39610514919) **FAILED**, exactly Windows `browser-live` job `119257845386` on `Physical Windows Job Object regressions`. `Windows Job fast-exit stdout and stderr are drained before exited status`, `test/windows-job-owner.test.ts:216`, iteration **5**, error **must not announce exited before stdout is captured**; Job step: 20 PASS, 1 FAIL, 0 SKIP. Other six jobs SUCCESS. This is a true stdout-versus-status issue and no evidence of a successfully elevated command or UAC authorization.
- [#633 exact HEAD c429ed9 CI #39610643900](https://github.com/Naveax/Nexowire/actions/runs/39610643900) **7/7 SUCCESS**, including hosted Windows browser-live. [Release Readiness #39610643844](https://github.com/Naveax/Nexowire/actions/runs/39610643844) package jobs Ubuntu/Windows/macOS SUCCESS; publish/attest release steps SKIPPED (NOT production release). The #633 Windows Job owner source includes the verified #576 early stdout/stderr subscription and independent kernel attestation, not a no-op skip of the original failure.
- **Critical distinction:** these are different source trees and SHAs. Neither #633 CI nor this QA converts #618's failed exact run into success, and neither proves actual installed signed High-token Broker / CORE dispatch.

## New independent adversarial source tests

`test/qa-02-core-633-elevated-outcome-negative.test.ts` includes:
1. Strict typed `requestId` and exact response correlation; rejects caller supplied `approved:true`, `consentExePresent`, `operationSuccess`, malformed request IDs and extra fields. `CORE_EXECUTOR_DISPATCH_ENABLED` is unconditionally false; even all-positive synthetic claims yield `ELEVATED_DISPATCH_NOT_INSTALLED`, `privilegedExecutionOccurred:false`, `verifiedEffect:false`.
2. Legitimate **once-approved** Broker/owner CORE means `requiresPerCommandUac:false`, not a new UAC per command. Missing real local one-time enrollment proof results in `LOCAL_ONE_TIME_UAC_BOOTSTRAP_UNVERIFIED` / `pending`, never a fake consent click. All-positive fixture flags are purely **test inputs**, not independently attested OS elevation.
3. Owner epoch, ownerAccountId, deviceId and credential binding mismatch, revoked grant and missing high-token/owner epoch witness fail closed with original requestId. Current external monotonic authority not implemented by this pure function.
4. A **QA-only synthetic receipt oracle** rejects ACK-only, stale `Running`, wrong VMId/host/owner/requestId/epoch, missing actual-native provenance and wrong state. A positive synthetic control is **not** physical postcondition evidence: no Windows VM query is performed.
5. Lost mutation acknowledgement, reserved duplicate `requestId`, and unavailable external CAS return `unknown` / no-replay; `MUTATION_STATE_UNKNOWN` and dispatched or unknown `UNAVAILABLE` preserve `reconcile_first`, never automatically rerun elevated shell/Hyper-V.
6. Real `IdempotencyStore` and `AuditLog` with synthetic elevated request: record `started → unknown`, preserve original operationId and requestId in audit through journal restart, redact synthetic Bearer, reject same-key different ownerEpoch fingerprint with `IDEMPOTENCY_KEY_REUSED`. This **does not** instantiate a Broker or execute commands.

The existing `test/core-broker-executor-contract.test.ts` and `test/windows-job-owner.test.ts` are not touched, deleted, skipped or weakened. This QA commit modifies **only** `test/` and `docs/`. No #03 or #04 owner files, no live UAC/Agent/Broker/Hyp-V/ACL, and no ReVoltVPN-Ubuntu-Lab VM. Production P0 remains **NO-GO** pending trusted physical installer/signature/high-token, #271 protected ACL, #587 external CAS/owner epoch witness, owner revoke, independently attested shell exit/VM postcondition and independent security approval.

## Validation

- Parent #633 exact-head 7/7 GitHub and release readiness results verified independently.
- This QA branch's new **exact-head** GitHub CI, local TypeScript/build/test status and any blocked gates must be recorded separately; no parent green inherited without the new combined source SHA.
