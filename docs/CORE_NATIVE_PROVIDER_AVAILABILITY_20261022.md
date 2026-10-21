# #10 Broker native availability / FILETIME / CAS QA on #709

Date: 2026-10-22 (Istanbul). **Source-only / DRAFT / production CORE NO-GO.** This branch is stacked on #709 exact head `b083004b9ab8c18125a428cf74f3e97f7adf4e88` (CI `39658979397` SUCCESS). Only new #10-owned paths under `src/diagnostics/`, `test/`, `docs/`; no changes to #03 Broker/Job owner source or #04 Access or #01 external CAS implementation.

## Exact previous and dependency evidence
- #715 exact HEAD `550b10c07df648e1b0991770ec7c78fb2984d026`, CI `39659290064` FAILURE, six successful jobs, **only** `browser-live` Windows Job fast-exit stdout race in `test/windows-job-owner.test.ts:216`, iteration 3. #715 diagnostics source/test failure was **not** reported. It stays RED; we did not disable or skip this test.
- #709 exact HEAD `b083004b9ab8c18125a428cf74f3e97f7adf4e88`, CI `39658979397` SUCCESS, addresses #700's missing import/updater ancestor/path alias and real ACL read failures with read-only Windows fixture. **No claim** of an installed signed running HIGH-integrity Broker or signed release/rollback manifest.
- #712 exact HEAD `62800af17d2a9ce18670dba6a8ac861a5d7f4ba5`, CI `39659225895` SUCCESS. Source nonce/owner epoch and WAL restore regression evidence; **external independent monotonic CAS authority is not physically deployed**. We did not edit #712.

## Source-only compatible-branch acceptance
Copied the three #715-owned diagnostic/test/docs files unchanged, using original verified blob content, onto green #709 as an **updated compatible base**. New `src/diagnostics/core-native-provider-availability.ts` is a self-contained injected-readonly **availability comparator**: no installed witness provider -> `UNAVAILABLE`, mixed input -> `PARTIAL`, all reported inputs -> `REPORTED_UNATTESTED`. A synthetically reported High/System same-PID and exact decimal creation FILETIME is labelled `HIGH_CLAIM_UNATTESTED`, *never* `installedHighBroker=verified`.

**It does not call Windows APIs, the Agent, service, UAC, ACL, VM, or Broker 43112**; thrown/malformed native reader messages are sanitized. Captures each provider at most once and passes the immutable report to `assessReadonlyBrokerEpoch`. Even all-green synthetic reports keep `installedHighBroker=NOT_PROVEN`, `independentWitnessDeployed=NOT_PROVEN`, `effectiveCore=false`, `authorizationGranted=false`, and `replaySafe=false`.

Additional negative fixtures: signed running image provider UNAVAILABLE, reused PID with **wrong 64-bit Win32 FILETIME**, missing/unsafe updater/import ACL and `PROCESS_DUP_HANDLE`, unauthenticated/cached 401, consent.exe plus CORE preference, stale cached owner epoch vs the external CAS generation, independent witness unavailable, and callback errors containing secret-like strings. Synthetic only; no real elevated task or physical device claim.

**Release NO-GO:** running protected Authenticode-pinned Broker image, same-instance HIGH token, full effective imported/update file and ancestor ACL, current independently signed owner CORE grant and non-co-restorable CAS/revoke authority remain unverified physically. New exact-head GitHub CI on the stacked branch must be reported independently and not confused with an existing Windows Job red run.
