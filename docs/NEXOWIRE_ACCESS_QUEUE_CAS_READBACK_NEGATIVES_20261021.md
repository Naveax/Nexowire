# Access #04: queued CORE/ROOT revalidation vs #700 native and #702 external dispatch

**Date:** 2026-10-21. **Scope:** Access-owned source-only independent
DRAFT child of #669. No running OS privilege or remote CAS deployment.

## Actual cross-PR source review

- **#700 native provider** exact HEAD
  `637ff3a6e8705e94e6ffba91790fd83329beee3f`, GitHub
  Actions `39645643225`: overall **FAILURE**.
  `browser-live` job dedicated Windows Broker proof step fails three
  `test/core-broker-protected-tree.test.ts` cases (import/updater
  ancestor inventory, signed/forged manifest out-of-root rejection,
  inherited low-trust Modify). Other six jobs SUCCESS. Failure must NOT
  be suppressed or reinterpreted as a green provider.
  `audit-windows-broker-token-provider.ps1` records only its *own*
  inspecting process Win32 token/PID creation time. It explicitly
  reports real installed Broker PID, image/epoch, dup-handle and
  complete import tree as NOT ATTESTED. Access must NEVER accept
  `ownInspectingProcessToken` as protected Broker HIGH identity.
  `core-broker-process-witness.ts` is a fail-closed status source;
  even synthetic all-positive flags return
  `PRODUCTION_EXECUTOR_NOT_INSTALLED`.
- **#702 remote dispatch CAS** exact HEAD
  `576eab8926c8257c13a47fa1be806554e2ecd190`,
  Actions `39646460335`: **SUCCESS**.
  `BrokerExternalDispatchFence` has an authenticated external
  `beginIfCurrent` dispatch permit, `revokeAndDrain`, `release`;
  source tests use an isolated CAS simulator and disposable TLS.
  A signed permit is **one dispatch reservation**, NOT independently
  fresh read-only CAS high-water status. No actual remote CAS
  deployment, physically independent key custody or protected
  native execution adapter was proven. No #01 files edited.

## Implemented scoped Access defense

`src/product/access-queued-job-review.ts` adds a **read-only review
before a proposed new privileged side-effect boundary**:

1. Requires typed currently-queued request, exact owner account,
   device, paired credential hash and session hash, current
   authenticated (unrevoked) login and CORE preference or ROOT issued
   window of **at most 900000ms**, and rejects expiry at the exact
   boundary.
2. Calls `AccessEffectiveAuthority.project` fresh for D1 durable
   CORE enrollment / D1 ROOT grant plus independently signed,
   verified protected Broker + external epoch status. Cached browser
   `effective:true`, Agent `adminBridgeReady` and untrusted
   loopback `/health 401` are not inputs.
3. Requires a separate server-provisioned protected **authenticated
   CAS readback**. Ed25519 signs an exact owner/device/device epoch/
   session epoch/grant generation/request UUID/mode/status and
   short bounded observation window. Rejects changed signer, replayed
   foreign scope, revoked grant, future/expired observation.
4. Compares readback to independent current monotonic owner-epoch and
   generation high-water values, **after** the readback, rejecting a
   revoked owner during a queued/awaiting command. Missing/timeout
   proof always blocks. Potentially dispatched commands yield
   `UNKNOWN_RECONCILE` without replay, not a successful effect.
5. Even all synthetic green tests only yield
   `REVIEWED_ONLY_NO_DISPATCH` with
   `elevatedDispatchAllowed:false`. This readback is NOT an
   atomic authorization against the read→execution race: the actual
   #702 remote `beginIfCurrent` has to serialize each real
   side-effect start with revoke/re-pair and the Broker native
   dispatch. Thus the module deliberately has **no executor**.
   No repeated per-command Windows UAC is required after a genuine
   once-approved local signed enrollment; independent CAS fence is
   not a UAC consent prompt.

`test/access-queued-job-review.test.ts` exercises real Ed25519
signatures, all source-only synthetic identities, exact 15-minute
boundary, signed wrong owner/device/epoch/authority, cached UI
spoof, pending external revoke with deterministic Promise barrier,
lost side-effect ACK and independent high-water mismatch. Test
fixture's keys/remote readback do NOT establish real physically
independent CAS or high-token Broker.

## Production and scope

#271 inherited Authenticated Users Modify on Naveax Stack/CLI,
Broker ACL Access Denied, #551 signed installer, #700 unresolved
Windows protected source regressions, #702 remote CAS service and
physical native Broker startup/revoke all remain **NO-GO**.

This branch never changes #03/#01 implementation or #23 UI QA,
does not alter running Windows ACL/UAC/service/VM, and does not
try privileged shell, browser consent, remote dispatch or deploy.
