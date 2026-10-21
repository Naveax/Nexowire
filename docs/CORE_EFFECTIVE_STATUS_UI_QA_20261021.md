# Worker #23: CORE effective status UI, independent source QA

This isolated branch adds a read-only UI status projection with synthetic signed
Ed25519 broker and external monotonic-epoch witnesses. **No `web/app.js`, #04
Access files, Windows Broker, Agent, UAC, VM, or live process is modified.**
This projection is **not yet wired to the production dashboard**.

## Evidence and UI interpretation

- SAFE means restricted user-level access. FULL means broad **standard-user**
  actions and cannot imply an elevated Windows token.
- ROOT is an owner+login-session bound lease valid for at most 900,000 ms; its
  exact expiry boundary disables the UI candidate without background polling.
  The native signed Broker receipt binds grant mode and both lease timestamps;
  a signed CORE receipt cannot be relabeled as ROOT, and forged lease dates fail.
- CORE is a persistent requested owner preference, not proof of elevation.
  It does not expire at 15 minutes but is paused when offline or without fresh
  authenticated native Broker and independently signed non-revoked external
  owner epoch/generation witness. Revoke, owner/session change, SAFE, missing
  proof or ACL mismatch fail closed.
- Native Broker candidate requires a pinned Ed25519 signer; pinned Broker
  executable SHA/version; authenticated Broker; actual high token with enabled
  Administrators SID; signed publisher; protected parent, imports, and task
  identity; and independently attested enrollment.
- The external witness must be separately signed by a *different authority*,
  fresh, unrevoked and have the exact matching owner, device, epoch and grant
  generation and independently fetched current epoch/generation high-watermark.
  Replayed old signed pairs fail if the trusted CAS high-watermark advanced.
  Stale or future signatures fail closed. It is not enough to
  insert `effective:true` or `authoritySource` in the dashboard JSON.
- `consent.exe`, TCP listener on 43112, HTTP 401, Agent `brokerReady`, stored
  CORE `active` and UI selection are deliberately ignored for OS privileges.
- `ROOT_SIGNED_BROKER` / `CORE_SIGNED_BROKER` mean only **source-consistent
  signatures at UI read time**, not a license for Windows execution.
  `grantsExecution:false` and `uacApprovalProvenByUi:false` are invariant.

## Before #04 integration or physical acceptance

The native public key must be genuinely pinned to an independently audited,
protected Windows collector with real Authenticode publisher, binary + import
source and parent ACL verification, effective elevated token and local consent
enrollment. The second signer must be a genuinely external monotonic CAS
revocation authority. Merely generating unit-test Ed25519 keys **does not**
provide either custody, rollback resistance, or independent Windows evidence.
Verified owner session binding and externally durable revoke propagation are
still required. UI must consume a trusted server projection, never instantiate
trust pins from client-controlled payloads. #271/#551/#587/#617 remain NO-GO.

Run `node --test --import tsx test/core-effective-ui-status.test.ts` and
`npm run typecheck` on the exact branch HEAD. No live Agent 1.0.5 change and
no ReVoltVPN-Ubuntu-Lab operation is permitted.
