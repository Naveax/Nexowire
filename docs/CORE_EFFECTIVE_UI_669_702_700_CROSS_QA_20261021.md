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

## #23 2026-10-22 stale-green prevention: #757 Access / #756 OS TEMP / #753 JSON

- #726 exact prior `2c0b7a99401ed7432bbf6f31fd2da59bab97e091` workflow `39735208426` **SUCCESS**. Its Node22 and Node24 logs explicitly run the nested `test/qa/core-effective-ui-worker23.test.ts` importer and report **21 PASS, 0 SKIP**; source CI is not physical privilege acceptance.
- #757 exact `93acbb7a4e830485ce94015b3c76837a3fcdad34`, CI `39736445337` **SUCCESS**. Its nonce-bound review and `revoking:false` signed readback deny delayed/revoked permits, but the final read-to-effect atomic race and protected installed Broker acceptance remain unproven. The UI v2 *synthetic only* separate native+CAS signing contract now demands the **same independently pinned fresh 32-byte challenge nonce**, and rejects a CAS `revoking:true` even when `revoked:false`.
- #756 exact `d4ed32f72701e5157929cbb9d36bdf0a90fc0d57`, CI `39736305461` plus dedicated `39736305459` **SUCCESS**. These are genuine *TEMP-only* Windows kernel access/PID/FILETIME probes, not installed signed HIGH Nexowire Broker. The emitted source witness explicitly has `installedBrokerProcessAttested:false`, `fullTransitiveImportInventoryVerified:false`, `separateLowPrivilegeTokenBoundaryVerified:false`, `protectedJobHandleInheritanceAndDaclVerified:false`, `signedReleaseAndRollbackManifestVerified:false`, `productionReady:false`. A same-user `PROCESS_DUP_HANDLE` ALLOW is **not** isolation proof.
- #753 exact `72ff16a23881c9dfde52f7bb5190bdf6185457e5`, CI `39735984623` and `39735984797` **SUCCESS**. Its *diagnostic* test reproduces PowerShell JSON version `"1"` / `true` being wrongly accepted by coercion. These PASS outcomes do not approve the input. The #23 UI status contract checks required booleans and epochs by strict runtime value/type, so strings like `"true"` or `"4"` cannot become trusted HIGH/CAS evidence.

**Narrow #23 independent QA correction:** Previously a source mock with `productionReady:true` plus generated Ed25519 keys could drive `projectVerifiedCoreUi` to synthetic EFFECTIVE despite absent explicit full transitive import inventory / native effective low-privilege boundary / protected installed Broker identity, or an untrusted CAS authority. The read-only projection now additionally **fails closed** unless ALL native physical-acceptance fields are explicitly true, and trusted out-of-band signer and external monotonic CAS acceptance pins are true. False/missing/wrong-typed values and in-progress revoke remain `PAUSED_UNVERIFIED`. Positive fixtures remain synthetic and are **not** a genuine physical claim.

The separate proposed UI v2 nonce/CAS schema is NOT implemented in #757/#712 production providers. UI may never infer external CAS deployment, signing key custody, protected token or full loader closure from browser claims or JSON `version:1` receipts. Existing #23 CI wrapper remains unchanged, and new exact-HEAD hosted logs must confirm **25** registered tests (previous 21 plus four new) with 0 skip. Keep DRAFT; no Access/Broker/native JSON importer changes, no live UAC/VM.

## #23 late signed final CAS launch review (#767) and #763 strict native JSON

Current owner evidence:
- #767 HEAD `6967cc92ae85e5d1034591940d273615c4056e00`
  defines `nexowire.access.final-native-effect-grant.v1`, an Ed25519-signed
  proposed final native-effect CAS grant bound to original permit nonce,
  new launch nonce, owner/device/session epoch, generation, request and
  dispatch ID, image SHA256 and installed PID/creation FILETIME.
  Even an accepted synthetic signature returns
  `FINAL_SOURCE_CANDIDATE_ONLY`, `canLaunch:false`,
  `dispatchEffective:false`; the native effect has **not** been
  atomically fenced by a deployed external revoke/dispatch authority.
  The signed CAS receipt by itself MUST NOT become UI CORE EFFECTIVE
  or a dispatch permit. Owner #767's physical execution boundary is NO-GO.
- #763 HEAD `e67f8f4ce14adb161a81f1f1ab45becbf5d7f40c`
  repairs strict JSON version 1 type coercion by accepting only actual
  Int32/Int64 integer 1 and preserving legacy read-only ACL inspection.
  Its source compile/CI success cannot attest a high-integrity installed
  protected Broker, complete transitive image tree, or external CAS.
- #726 older exact HEAD `ea0df4788b9efb1d457f941f70024a60e9b4c815`
  already had Node22/24 **25/25 discovered PASS** at CI `39802783523`,
  but the full hosted run's Windows `browser-live` was still
  **IN_PROGRESS** at the last independently checked observation.
  Historical source PASS never substitutes for exact new HEAD verification.

New narrow negative contract: the read-only UI projection now requires
a **separately witnessed final-launch installed native HIGH Broker token/
PID+FILETIME reattestation**, a physically verified *atomic native effect
commit versus revoke start*, and external protected CAS evidence that its
**final grant commits at that very native launch**. These are NOT
equivalent to a cached signed queue review, a #712 permit, a #757
post-permit readback, or #767's correctly signed
`FINAL_SOURCE_CANDIDATE_ONLY`. All three witness fields must be strictly
true; omitted, false, string or number substitutes stay
`PAUSED_UNVERIFIED` with `canDispatch:false`.
The new two tests specifically reject correctly signed alternative final
grant/queued review schemas and absent atomic boundaries. The existing
test-discovery wrapper is unchanged; expected current QA registrations:
**27** (previous 25 + 2 narrow negatives). All simulated positive booleans
and signer keys are *hypothetical*, **not physical evidence**.

#763 strict numeric version belongs exclusively to the #03 native importer;
do not duplicate its Windows TEMP fixtures or bypass owner code.
No new PR, no #04/#03/#01 source, UAC, VM, Agent, physical ACL or
production release changes. **DRAFT / CORE EFFECTIVE NO-GO**.
