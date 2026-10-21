# #10 CORE Broker: native provider unavailable / replay-cached 401 acceptance

Date: 2026-10-21. Source-only DRAFT follow-up to #665. **No live UAC, ACL, Broker, Agent service or VM modification.**

## Stage-specific inherited red CI

Prior exact head `83fb4bbf770b1bb493179dc05e2f9825b4d70637`, GitHub Actions run `39631516050`, returned six SUCCESS jobs and one FAILURE: Windows `browser-live` job `119330666644`. Independently fetched job logs show `test/windows-job-owner.test.ts:216`, **fast-exit stdout/stderr drain before exited status**, failure on **iteration 5** (20/21 Windows Job tests passed). The target #10 diagnostics was NOT the failed stage. Do not modify #03 Job files, skip tests, or claim overall green.

## Independent read-only evidence

`src/diagnostics/core-broker-readonly-preflight.ts` distinguishes five independently reported evidence authorities: Authenticode-signed **running image PID and publisher certificate pin**, same-PID Windows High/System token, protected **parent/import AND updater path/import** ACL, signed current owner/device CORE grant epoch, and independently authenticated rollback-external CAS witness with matching epoch/revoke readback.

`readStatusRequest` is a **separate transport/status inquiry** with a fresh request ID and response correlation. Neither an HTTP 401, a cached response, `consent.exe` being visible, nor the UI CORE badge proves signed running high-token Broker or owner enrollment. Replayed/stale/uncorrelated responses remain BLOCKED.

New `src/diagnostics/core-broker-native-unavailable.ts` exposes an injected reader-only factory. **No native reader registered -> provider UNAVAILABLE**. Throws/malformed reports -> UNAVAILABLE without exposing raw errors/secrets. It never executes PowerShell, calls port 43112, reads tokens, changes UAC or ACL, starts a VM, or dispatches elevated work.

**Crucial:** all source-level providers are still **untrusted JSON reporters**. Even "all-green" synthetic reports return `trustedAttestation=false`, `actualWindowsElevation=NOT_PROVEN`, `effectiveCore=false`, `authorizationGranted=false`, `brokerMayExecute=false`. Real native witness/verifier belongs to separately approved #03 Broker, #04 Access, #01 CAS owner files and requires independently authenticated freshness and protected running-image identity.

## Tests and release

Additional source-only negative tests cover missing native provider, exception redaction, malformed report, status vs High token, replay-cached HTTP 401 across two unique request IDs, missing response correlation, `consent.exe`/CORE badge, unprotected updater, publisher thumbprint mismatch and unavailable CAS witness.

**Production remains NO-GO.** Real Broker Authenticode publisher, parent/updater effective ACL, High token PID creation-time binding, external CAS epoch and actual signed CORE authorization have not been deployed or physically attested by this work. Exact HEAD GitHub CI must be checked separately; inherited Windows Job failure does not become green simply because focused diagnostics tests pass.
