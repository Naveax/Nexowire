# Worker #23: CORE EFFECTIVE UI cross-contract QA (#669 + #702 + #700)

## Verified exact source heads (2026-10-21)

- #686 (independent QA parent) `c46f9138b9af32b798b40a0e9d8e21b2e147ddae`, hosted workflow `39644614653` **SUCCESS**, all seven jobs.
- #669 (Access owner) `99894af2c224d80ce4edeb71c1e98701f6c22ab8`, workflow `39632774193` **SUCCESS**. `AccessEffectiveAuthority.project` checks independently signed native HIGH/Administrators/publisher+updater ACL and a separately signed external owner epoch, D1 enrollment, current login and pinned image/version, but has no signed reconnect incarnation in its v1 attestation.
- #702 (external dispatch fence owner) `576eab8926c8257c13a47fa1be806554e2ecd190`, workflow `39646460335` **SUCCESS**. Its remote `beginIfCurrent` receipt is a **single-use short-lived dispatch permit** scoped to authenticated owner/device/session epoch, generation, capability, request ID and signed high Broker. It is **not** a general UI-status attestation; the external authority's actual deployed monotonic service remains unproven.
- #700 (native Windows Broker provider owner) `637ff3a6e8705e94e6ffba91790fd83329beee3f`, workflow `39645643225` **FAILURE**, specifically hosted `browser-live` at `Verify independent Windows signed Broker and high-token provider negatives`. Six other jobs succeeded. Native `assessBrokerRuntimeIdentity` requires PID + FILETIME + volume/file ID + image SHA, full protected executable/ancestors/import/updater trust, high Administrators token, and protected duplicate-handle boundary. **Current implementation returns** `actualHighIntegrityBrokerAccepted:false` and `productionReady:false` **for all results**, including synthetic positive source facts (`PRODUCTION_EXECUTOR_NOT_INSTALLED`). Never imply #700 physically attested HIGH or that Windows red tests can be skipped.

## New independent UI-readback proof proposal

`src/diagnostics/core-effective-native-cas-ui-gate.ts` is **#23-owned prototype**, not an adapter wired into #04's ControlPlane dashboard. `projectVerifiedCoreUi()` requires all of:

1. #669 `EFFECTIVE` Access status with independent HIGH token, protected ACL and explicit non-dispatch status.
2. A separately accepted native runtime assessment. Because #700 **currently returns false** for this condition, the real combination always yields **PAUSED_UNVERIFIED**.
3. Independently signed, fresh native v2 readback with current owner/device/credential/session, **deviceEpoch and sessionEpoch**, current owner epoch/generation, matching installed image SHA/version, live PID/creation FILETIME/volume/file identity, confirmed HIGH Administrators, verified publisher/release, protected EXE/ancestors/import/updater and process-handle ACL, authenticated Broker and local bootstrap.
4. **Separate Ed25519 CAS signer**, with v2 UI-status witness for exact device/session epochs, owner epoch, generation and non-revocation. A #702 `broker_dispatch_permit_v1` is rejected even when it carries a valid CAS signature: a *dispatch* authority token must never become a *UI* proof.
5. Owner/device/session epochs and Broker process/image identity are separately read from **trusted server-side readback**, never submitted by browser snapshots. Both signatures are restricted to a 5-second maximum age and bound to their schema and fields.

This **new UI v2 proof schema is only a proposed source contract**. #669 does not emit it, #702 does not emit it, and #700 has no physically accepted deployed provider. Fabricating tests with synthetic Ed25519 keys proves only deterministic source logic; a fabricated `runtime.productionReady:true` in unit tests is not real privilege evidence. No production UI EFFECTIVE may be shown on the basis of this proposal alone.

## Independent regression matrix

- A 1-ms-old signed native/CAS pair from the prior reconnect epoch is denied with refreshed device/session epoch, even though timestamps remain valid. Both new independent signatures must match the new epoch to be a source-consistent candidate.
- Owner re-pair changes credential/session/owner or owner epoch and invalidates cached receipts. External generation rollback, revoked or missing CAS, or foreign/shared signing key fail closed.
- Restored or upgraded same-version Broker with stale image SHA, replaced PID/FileTime/volume+file ID, no publisher/ancestor/import/updater ACL, no high token or unsafe duplicate handle remains pending.
- `consent.exe`, HTTP 401, caller CORE badge, Agent readiness and requested CORE mode have no authority. A source test poisons UI cosmetic fields to detect accidental reads.
- An #702 signed dispatch permit is rejected by the distinct UI status schema, and an UNKNOWN/pending native effect does not grant any UI authority.
- Every branch emits `canDispatch:false` and `uacProvenByAppearance:false`. No actual command authorization or physical UAC is implemented.

## Ownership and release

Changes are limited to the new #23 QA adapter/tests and this review document. **No** `src/product/access-effective-authority.ts`, ControlPlane, web/app.js, #01 CAS owner files, #03 native provider files, UAC, VM, Broker service, Agent, Cloudflare, D1, user filesystem or production ACL mutations.

**RELEASE: BLOCKED / NO-GO** regardless of successful source CI until native Windows publisher/PID/ACL/HIGH proof is physically accepted and protected external CAS deployed. Do not auto-merge or convert DRAFT to ready.

## #23 follow-up on current owner branches, 2026-10-22

Confirmed #726 exact `8f35bb1a5eeebd690e5b7047d3246983929751a0`
GitHub workflow `39659786915` **SUCCESS**, all seven jobs. No fabricated
physical witness.

- **#719 Access** exact `597191102dabc22e22c7f9822a026bbd12d60c52`,
  hosted `39659394811` **SUCCESS**. `reviewQueuedAccess` checks a fresh
  authenticated request-scoped CAS readback with `deviceEpoch`,
  `sessionEpoch`, `ownerEpoch`, `grantGeneration`, request ID, owner,
  device, revocation and independent high watermark. It returns
  `REVIEWED_ONLY_NO_DISPATCH`, with `cachedUiTrusted:false`.
  Its signed `nexowire.access.cas-readback.v1` is **not** an independent
  native UI-status witness.
- **#709 protected tree** exact `b083004b9ab8c18125a428cf74f3e97f7adf4e88`,
  hosted `39658979397` **SUCCESS**: fixes Windows native protected
  EXE/import/updater/ancestor path binding and ACL fixture failures from
  #700. This does not install a protected native Broker or change inherited
  source `assessBrokerRuntimeIdentity` output:
  `actualHighIntegrityBrokerAccepted:false`,
  `productionReady:false`, `PRODUCTION_EXECUTOR_NOT_INSTALLED`.
- **#712 external CAS** exact `62800af17d2a9ce18670dba6a8ac861a5d7f4ba5`,
  hosted `39659225895` **SUCCESS**: nonce-, owner-epoch-, generation-,
  device- and session-bound single-use **dispatch** permit. The
  `broker_dispatch_permit_v1` is not a status readback. Actual
  monotonic remote service deployment/physical proof remains unverified.

Existing #726 read-only gate already rejects 1ms prior signed device/session
epoch after reconnect, owner re-pair, stale image SHA and same-PID different
creation FILETIME, EXE/ancestor/import/updater ACL loss, HIGH token false,
unauthenticated HTTP401 and stale `consent.exe`. Added narrowly scoped
independent negatives for **native collector signer rotation or tampered
signed image**, source-only #709 protected-tree PASS without physically
accepted HIGH, and **#719 signed queue readback never being upgraded into
UI EFFECTIVE**, including owner epoch rollback just 1ms after a valid pair.

All positive native/CAS keys and `productionReady:true` in these QA tests
are intentionally **hypothetical**, never real protected token evidence.
Do not use cached badges, `401`, `consent.exe`, #719 readback or #712
permit as native Windows HIGH proof. No #04/#03/#01 owner source changes,
physical UAC/VM or production deployment. **DRAFT, PRODUCTION NO-GO**.

## Hosted CI discovery and coverage correction

The root package `npm test` script invokes
`node --test --import tsx test/**/*.test.ts`.
The default shell glob `test/**/*.test.ts` does **not automatically include**
root `test/*.test.ts` files; before this fix a green Node check could
compile the #23 tests without actually executing them.

`test/qa/core-effective-ui-worker23.test.ts` now imports both existing
root-level #23 suites. The npm script's nested pattern includes that QA
entrypoint on Linux/Windows bash alike. This is intentional **CI coverage
binding**, not new duplicate cases or a relaxation of any negative.
Expected independent test registrations after prior 12-case extension:
9 owner-#669 negatives plus 12 native/CAS UI-gate tests = **21**.
An exact-HEAD hosted Node22/24 result for the wrapper is required before
claiming the 21 tests PASS. No unrelated workflow or owner source is changed.

## Exact-HEAD CI failure and QA-only syntax repair

Exact `e6e79226c51fc17d1df801e5013d79887db9a45d` workflow
`39677945795` completed **FAILURE**. Actual hosted Windows/Linux/macOS
`npm run typecheck` failed on
`test/qa/core-effective-ui-worker23.test.ts` line 3 because its old
block comment contained a `*/` terminator within a printed test glob.
This was a **real source error**, not an inherited Windows Job or
evidence that the 21 tests ran. No failed tests were skipped.

The discovery entrypoint was rewritten using plain `//` comments.
Its two import statements and all independent #23 assertions are
unchanged. A new exact-SHA CI must pass typecheck **and** show the
test names / count from both suites in actual Node job logs before
source QA PASS is reported. Production still **NO-GO**.
