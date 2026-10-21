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
