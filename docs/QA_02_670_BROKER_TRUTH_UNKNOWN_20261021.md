# #02: independent native Broker truth negatives after #670

Date: 2026-10-21. Repo: Naveax/Nexowire.

**Source base:** DRAFT [#670](https://github.com/Naveax/Nexowire/pull/670), exact HEAD `cc5f3db53ec38224a1c632bee96d1cf98095b89d`. Its [CI #39633083937](https://github.com/Naveax/Nexowire/actions/runs/39633083937) is verified **7/7 SUCCESS**. Its own Windows-native provider checks do **not** establish production Broker authority. #670 inherits signed native Windows Job source from #633.

**Previous #02 proof:** [#661](https://github.com/Naveax/Nexowire/pull/661), exact HEAD `849035d0186938a7ba4e717e03c7a039a7f0598a`, [CI #39631109283](https://github.com/Naveax/Nexowire/actions/runs/39631109283) **7/7 SUCCESS**. Its two QA files are cherry-picked unmodified into this new child, with identical Git blob identities; no #03/#04 implementation source changed.

## New independent source-only negative acceptance

The added `test/qa-02-670-native-broker-truth-negative.test.ts` has six adversarial cases:

1. **Native evidence origin:** inspect actual shipped `audit-windows-broker-token-provider.ps1` source. The native Win32 token query calls `GetCurrentProcess()`: it queries **the inspecting PowerShell process**, not the installed Nexowire Broker. Source flags for actual Broker PID/running image/owner epoch/signed manifest/import tree/high token, elevated dispatch and production readiness must each remain explicitly `false`. Native test PowerShell token High alone is not an installed signed high-token Broker witness.
2. **Missing token witness:** `CoreBrokerContext` rejects missing independent-native provenance, High/Admin token, signed running image, broker authentication or handle-dup protection with `ELEVATED_BROKER_IDENTITY_OR_ACL_UNVERIFIED`. Request ID remains unchanged.
3. **Physical UAC forgery:** strict typed request refuses `approved`, `consentExePresent`, `uacClicked`, `physicalUacApproved` or `transportOk`. Missing first *local physical* trusted enrollment proof is `LOCAL_ONE_TIME_UAC_BOOTSTRAP_UNVERIFIED`/PENDING. Already preapproved **verified signed CORE** requests do **not** demand a fresh UAC each time (`requiresPerCommandUac:false`).
4. **Owner epoch freshness:** wrong epoch/device/account and revoke or absent independent epoch witness fail closed, notwithstanding cached Core/UI flags.
5. **ACK vs effect:** typed broker gate rejects an untrusted `ack:true`/`vmState:'Running'` and never claims execution; a **pure QA-only synthetic readback oracle** rejects old/wrong VM state, host, owner, epoch, requestId or lack of independent native attestation. Its positive control is NOT real Windows VM readback.
6. **Crash persistence:** using the actual source `IdempotencyStore`, abandon `in_progress` after synthetic possible dispatch. A new journal instance reads `unknown`, preserves original operationId, creates no second reservation for the same key, and rejects a changed ownerEpoch fingerprint with `IDEMPOTENCY_KEY_REUSED`. `AuditLog` retains a redacted `started → unknown` sequence tied to exact requestId after restart; Error Contract reports `reconcile_first`. No actual Broker/shell/VM command is sent, and no automatic replay occurs.

## Evidence, non-acceptance and ownership

- Isolated Work PC typecheck PASS and focused `test/core-broker-executor-contract.test.ts` plus original #661 plus new #670 QA: **23/23 PASS** (0 FAIL, 0 SKIP).
- Broader local tests/build/continuation and the child **exact-head** CI are to be independently recorded after commit.
- No edits in `src/`, `scripts/`, `.github/workflows/` or any #03/#04 implementation. No skip or deletion of existing tests. Cherry-picked previous #661 QA and added only a QA test + docs report.
- **Production NO-GO:** Actual signed Nexowire Broker PID/running image/high token, independently bound owner/device/epoch and revoke/antirollback witness, physical first UAC enrollment, external monotonic CAS, protected ACL/import tree/handle duplication and authenticated effect/VM state readback all remain unproven.
- No live privileged shell/Start-VM/UAC/ACL manipulation, Agent/Broker restart, ReVoltVPN-Ubuntu-Lab or production/main change. QA worktree is isolated. The test's positive receipt is synthetic data, never a physical attestation.
