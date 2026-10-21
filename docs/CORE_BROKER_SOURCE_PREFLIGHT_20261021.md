# CORE Broker independent read-only preflight | 2026-10-21

**Source-only / diagnostic-only / production NO-GO.** This adapter is independent of #04 Access owner, #03 elevated executor owner, #23 UI acceptance, #01 external monotonic witness adapter, #618 Hyper-V, and #627 physical-readiness report. It must not be mistaken for an Agent-side attestation service.

## Diagnostic contract

New pure source-only async adapter: src/diagnostics/core-broker-readonly-preflight.ts. A caller supplies five separate read-only providers:

1. Running image: exact PID, observed running identity, Authenticode, pinned publisher, 64-hex SHA-256, claimed version, image-to-PID binding.
2. Windows token: high/system integrity, Administrators enabled and token-to-same-PID binding, not a Medium token, deny-only or preference.
3. Parent/import ACL: protected parent chain and import tree, no untrusted Modify/Write, identity bound to the observed running image. **ACL missing, unknown or inherited broad write is BLOCKED**, not safe.
4. CORE grant: active signed owner/device-specific grant and its current, revocation-checked non-negative monotonic epoch.
5. Independent external witness: source report of external CAS, signed receipt, owner/device match, same epoch, not revoked. **Unknown, unavailable, restored/in-memory CAS or stale epoch is BLOCKED.**

Untrusted UI/transport indicators (`401`, `consent.exe`, CORE badge) are explicit negative signals, never evidence of elevated execution.

The injected providers and their JSON outcomes are **not themselves trusted attestations**, even when the caller labels a report green. Consequently every result is `origin=injected_provider_untrusted`, `actualWindowsElevation=NOT_PROVEN`, `trustedAttestation=false`, `authorizationGranted=false`, `effectiveCore=false`, `brokerMayExecute=false`. Even an all-green synthetic injected provider returns `outcome=UNVERIFIED`, never READY. Real signed/attested authority must come from a separately owned and verified system implementation.

Provider rejections are fail-closed (`unavailable`), with their raw error strings deliberately excluded from the report to prevent secret exfiltration. Future, stale, malformed, pid-mismatched and owner/epoch-mismatched reports cannot satisfy preflight.

## Inherited GitHub CI failure provenance

#627 exact HEAD fed460da0e80af191b6663f146890ec6fd33824c, GitHub Actions CI run 39608830918: **FAILURE** on Windows browser-live job **only**; other six jobs succeeded. From actual job logs: 20/21 Windows Job tests PASS, 1 FAIL in test/windows-job-owner.test.ts:216, test "Windows Job fast-exit stdout and stderr are drained before exited status", iteration 2 missing stdout at exit. This is an inherited Windows Job/process test failure, **not** a success for the overall CI. It remains owner territory. #642 UI source effective-status QA is also blocked by inherited Windows Job failures. Do not modify their files to mask red.

## Local test strategy

Only src/diagnostics/, test/ and docs files are changed. Deterministic source fixtures fake signed broker, high token, owner grant and witness; no real signature or CAS authority is claimed. Test negative absent provider, swallowed error without secret, missing ACL, revoked grant, stale owner epoch, rollback witness, unsigned PID, Medium token, untrusted 401/consent UI, and forged all-green values. No live UAC, ACL edits, HTTP 43112 request, Broker install, VM start/stop, 1 GiB disk allocation or changes to signed Agent service.

**Release blockers remain:** independently signed/protected running Broker image, authentic high Windows token bound to its PID, protected import/parent ACL, signed persistent owner CORE delegation and revoke epoch, external rollback-resistant witness, and authenticated version-matched health. This source-only adapter does not satisfy these physical acceptance steps.
