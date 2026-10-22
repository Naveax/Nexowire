# QA #02: CurrentUser DPAPI closure and elevated outcome error contract

Date: 22 October 2026. Target: existing DRAFT [PR #727](https://github.com/Naveax/Nexowire/pull/727), **not** a new QA branch or a production deployment.

## Hosted evidence for the prior failure

The previous [#683 CI run 39644505625](https://github.com/Naveax/Nexowire/actions/runs/39644505625) ended FAILURE only in Windows `browser-live`. Its DPAPI/pre-logon Hub step returned 18 PASS / 2 FAIL / 2 existing conditional SKIPs: both **CurrentUser** DPAPI tests timed out after about 180 seconds with `WINDOWS_DPAPI_FAILED` at `src/security/windows-dpapi.ts:219`. LocalMachine DPAPI and Broker ciphertext tests passed; Windows Job and native Broker trust-negative steps passed. Cause beyond the observed child timeout remains UNKNOWN. It is not proof of UAC refusal, elevation, or an executed command.

Old #727 HEAD `7eeb40ce2e7d46e300e5f13754d2e8cd3615bb7a` subsequently passed **both**:
- [Full GitHub CI #39659834387](https://github.com/Naveax/Nexowire/actions/runs/39659834387): **7/7 SUCCESS**, Windows browser-live included.
- [Independent Windows DPAPI QA #39659834620](https://github.com/Naveax/Nexowire/actions/runs/39659834620): **SUCCESS**. The original, unchanged `windows-dpapi-secret.test.ts` and `protected-secret-files.test.ts` were run separately in order. Raw hosted job `119429650737` records both original CurrentUser DPAPI test names PASS. Neither was skipped nor given a higher timeout.

The new green execution does NOT retroactively turn #683's red CI green or prove the Windows DPAPI root cause fixed.

## Remaining Error Contract #02 gaps addressed narrowly

Existing #661/#683 source QA protects crash-persistent requestId/operationId `UNKNOWN`, no-replay, counterfeit consent and high token, stale CORE owner epoch and stale VM readback, but the output-only oracle previously lived inside test fixtures.

Added `src/protocol/elevated-outcome-error-contract.ts` and `test/qa-02-elevated-outcome-error-contract.test.ts`. The **strict source-only, non-dispatching** contract separates the reasons without accepting success:

| Evidence | Explicit diagnostic reason |
| --- | --- |
| Missing/stale owner epoch witness | `OWNER_EPOCH_NOT_CURRENT` |
| Revoked/missing CORE grant | `CORE_GRANT_NOT_CURRENT` |
| Missing authenticated installed High-token Broker witness | `BROKER_HIGH_TOKEN_WITNESS_MISSING` |
| First local physical UAC/bootstrap proof absent | `INITIAL_PHYSICAL_UAC_PROOF_MISSING` |
| ACK requestId or operationId mismatched | `ACK_REQUEST_ID_MISMATCH` |
| No independently read target state, even when ACK says success/exit 0 | `POSTCONDITION_MISSING` |
| Readback for wrong request, operation, VMId, host, owner or epoch | `POSTCONDITION_IDENTITY_MISMATCH` |
| Old pre-dispatch `Running` timestamp | `POSTCONDITION_STALE` |
| Wrong `Running` / `Off` target state | `POSTCONDITION_STATE_MISMATCH` |
| Even apparently matching untrusted postcondition without physical signed evidence | `POSTCONDITION_NATIVE_ATTESTATION_MISSING` |
| Injected `approved`, `consentExePresent`, `signedReceipt`, `highTokenVerified` | `FORGED_OR_INVALID_OBSERVATION` |

All returned outcomes after potentially dispatched mutations are **`MUTATION_STATE_UNKNOWN`**, `retrySafety:reconcile_first`, `effectVerified:false`, and `automaticallyRetryable:false`; the requestId and operationId remain correlated when the original request is well-formed. A verified, already-enrolled CORE model does not require a UAC prompt **per command**; that says nothing about whether the initial physical enrollment was really witnessed. This helper cannot authenticate Windows provenance or confirm successful VM/command execution. Even all-positive caller claims cannot make it return success.

New focused QA plus original #661/#683: **26/26 PASS**; broader 12 related files: **89/89 PASS**, no skips; typecheck/build/continuation PASS in isolated Work PC. New HEAD hosted full CI and independent DPAPI QA must be verified separately.

### Safety / ownership

No #03/#04 implementation paths, actual Windows Job, Agent, Broker, UAC, ACL, VM, ReVoltVPN-Ubuntu-Lab, or main/production change. The only new source lives in `src/protocol/` as an unattached #02 result explanation. The QA-specific hosted workflow appends the new tests while leaving the original full CI and both failing DPAPI test files intact. Release remains **NO-GO** until an independently attested signed installed Broker, owner/device/epoch witness, external CAS, and physical postcondition verifier exist.
