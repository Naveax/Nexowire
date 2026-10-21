# #04 Access: Effective CORE / ROOT evidence integration
**Date:** 2026-10-21. **Scope:** isolated Access owner child of #621.
**No live Windows operation, deployment, or permissions changed.**

## Integration implemented

`src/product/access-effective-authority.ts` produces an Access authority
**status**, not an elevated Windows command executor. It requires:
1. A fresh, authenticated current owner login; separate login-session
   revocation read in the ControlPlane store. A service identity or stale
   authenticated session cannot claim any privileged mode.
2. FULL access, a connected Windows Broker device, correct owner/device
   pairing and Bridge not explicitly OFF. SAFE/FULL never imply elevation.
3. **CORE:** a current device-specific D1 durable 0020 enrollment
   (`D1CoreDelegationLedger.currentCandidate`) plus current owner-enabled
   preference. Must match the present credential, installed image
   identity, pinned version and current grant generation. Durable enrollment
   remains on reconnect; logout disables effective status for an expired
   or revoked session; another authenticated session needs new fresh
   native proof but does **not** require new installation UAC.
4. **ROOT:** current login-hashed, unrevoked D1 0019 ROOT grant; expiry
   after at most 900,000 ms. The protected native signed proof binds
   exact lease timestamps and login hash. ROOT does not inherit CORE
   persistence.
5. Separately signed, fresh (15-second-max) **protected native
   Windows Broker** statement, authenticated and version-pinned, including
   independent high-integrity enabled Administrators, local one-time UAC
   bootstrap, publisher/release pins, parent+import+updater ACL and process
   handle boundary. No `consent.exe`, Agent mode or unauthenticated
   43112 HTTP 401 substitutes.
6. Separately signed, fresh external monotonic CAS owner epoch/grant
   generation high-watermark, equal to the protected native statement
   and separately fetched trusted current values; explicit external
   revocation denies. Native and external signing public keys must differ.
7. Only if every above check succeeds may the **server-side status**
   read `state:EFFECTIVE` and carry `authoritySource:
   independent-protected-windows-broker`; it explicitly returns
   `canDispatch:false`. General elevated shell/PowerShell/services,
   files, registry and Hyper-V through #633 remain **outside** this
   status projection. In a verified installed Broker, CORE/ROOT
   delegates do not need a new UAC prompt per command.
8. `ControlPlaneService.dashboard` now accepts an optional **server-only**
   `effectiveAuthority` instance. Without one it defaults to
   `active:false, effective:false`, with all attestation booleans
   false. The browser cannot directly supply public keys or trust
   roots; `web/app.js` consumes the server-projected effective
   fields rather than the legacy `core.active` or Broker ready telemetry.
   `rootMode.active` remains a policy lease status, separate
   `rootMode.effective` reports independent elevated proof.

## Test evidence and honest limitations

- `test/access-effective-authority.test.ts`: Ed25519 two-key
  signatures, external CAS monotonic fencing, stale/forged signer,
  high-token false, image/version, UAC and ACL denial, ROOT time
  boundary/session, CORE re-pair/logout/revoke and SAFE/FULL negatives.
- `test/access-effective-dashboard.test.ts`: actual
  `ControlPlaneService.dashboard` projection using Memory store and
  **synthetic** signed native/external providers. Revoke, logout,
  CORE OFF and SAFE return non-effective. Agent readiness alone does
  not grant administrator status.
- #23 QA PR #642 is an **independent diagnostic** reviewed for
  signed native/external source pairing. Its source/tests were NOT
  overwritten. #03 source PR #633 (broad Broker) was reviewed;
  executor files were NOT edited.
- Signature verification of synthetic keypairs in tests is only
  conditional proof mechanics. The runtime **does not yet install or
  provision a physically accepted** protected native signing key,
  signer custody, independently trusted Windows token collector or
  external monotonic CAS key. The shipping Cloudflare Worker provides
  no `effectiveAuthority` instance. Therefore both physical devices
  remain CORE EFFECTIVE = **false** in deployment. This is deliberate
  until independent physical acceptance; do not manufacture an
  `EFFECTIVE` result with fake `approved:true` flags.
- D1 migration 0020 is **not** deployed to Cloudflare staging or
  production. #271 real Naveax `ProgramData\NexowireStack` and
  `cli.js` remain writable by inherited Authenticated Users Modify,
  and protected Broker ACL is ACCESS DENIED / UNKNOWN. #551,
  #587 and real signed Broker source/Windows token remain pending.

**NO-GO: no main merge, physical UAC, live ACL/service/Broker/VM
mutation, elevated shell dispatch or production grant was performed.**
