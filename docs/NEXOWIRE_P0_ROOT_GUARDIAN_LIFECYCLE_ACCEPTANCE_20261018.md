# P0 Access, ROOT Session Lifecycle, CORE and Guardian Acceptance

Date: 2026-10-18. PR #548, branch `fix/parallel-04-access-core-adminbridge-20261018`.
Scope: isolated worktree only. No live Broker/service/task/ACL mutations; no main merge.
Related: #322 (CORE), #323 (Admin Bridge), #271 (protected Windows source ACL).

## Implemented in PR #548

- Per-login cryptographically signed cookie carries a unique random `sid`.
  Legacy signed cookies stay valid for ordinary account access but cannot create ROOT.
- New additive D1 migration `0019_root_session_lifecycle.sql` stores
  session hashes only, one current ROOT grant per device and durable revoked session hashes.
- Session ROOT admission uses one SQLite statement to compare owner/device
  Full Access/online state and the revocation ledger. A revoked cookie cannot
  claim a new ROOT lease. Grant expiry is the minimum of 15 minutes and
  the authenticated login expiry. Login/owner/device/scope isolation and
  timestamp/expiry are checked again for each dashboard/Authorization Explain read.
- Logout first persists session revocation and atomically deletes the matching
  session's active grants (D1 batch). Only confirmed writes return a successful
  cookie-clearing redirect; a DB failure returns a no-store 503.
  Replayed signed cookies are denied by subsequent authentication.
- SAFE, re-pair, expired grants, stale login, offline device and different login
  fail closed even when a preexisting legacy ROOT preference remains in the DB.
- `Authorization Explain.root.policyActive` is true only for the validated,
  unexpired, unrevoked login's **owner policy**. Its
  `operation.elevatedExecutionProven` always stays false.
  Windows admin token, UAC, physical-console grants and provider authorization
  require separate enforcement and local proof.
- CORE remains a durable, owner-revocable preference, not OS elevation.
  CORE `active` remains false / `PAUSED_UNVERIFIED` without independent
  authenticated Guardian/Broker evidence. SAFE and Admin Bridge OFF revoke CORE.
- Admin Bridge AUTO/ON/OFF is currently desired policy only. An inconsistency
  between Agent-reported readiness and requested ON/OFF produces machine-readable
  `BRIDGE_REPORTED_MODE_MISMATCH` with `REPORTED_MISMATCH` and a UI warning.
  These are untrusted reports, not a successful Guardian receipt.
- Existing signed-command reserve/replay/postcondition tests and local guarded
  scheduled-task reconciliation implementation are preserved; the public
  production command-delivery fuse remains disabled.

## Verified isolated acceptance

- Local TypeScript typecheck, build, continuation check, Worker/UI JS syntax PASS.
- Scoped 79/79 tests PASS, including real in-memory SQLite D1 migration,
  session replay and logout revocation, two-login isolation, device re-pair,
  SAFE, exact TTL, clock rollback and non-elevated Windows boundary cases.
- Tests use local SQLite, mocks and source inspection; no real Windows task
  transition was attempted. Passing a policy test is not physical proof.

## Read-only observations (not remote attestation)

| Physical target | Broker task | Guardian task and source | ACL |
| --- | --- | --- | --- |
| Naveax | Running, Highest | Guardian task and source not observed | `C:\ProgramData\Nexowire\privileged-broker` and legacy `C:\ProgramData\NexowireStack` report `Authenticated Users: Modify`; P0 BLOCKED |
| Work PC | Running, Highest | Guardian task and source not observed | Protected Broker root ACL query returned ACCESS DENIED; UNVERIFIED |

Both native Agents were previously reported as v1.0.5. A task being Running
is not trusted publisher, binary integrity, token or authenticated transport proof.

## Unresolved P0 / release gates

1. Security #271: remediate protected source ownership and inherited broad
   write ACL through a separately approved privileged installer; then
   re-verify ACL/reparse/source trust on both machines.
2. Install and enroll a genuinely independent signed Guardian with a
   protected task/source/credential, protected local replay ledger and
   authenticated transport that remains reachable while Broker is OFF.
   Guardian is not currently installed on either observed device.
3. Connect the existing owner-approved, paired, short-lived signed intent to
   the protected Guardian lifecycle and measured final postcondition. The
   production transport fuse must remain OFF before independent physical
   acceptance of ON/OFF/AUTO, crash/reconnect and revoke/replay.
4. Verify actual Windows console user SID, elevated task principal,
   UAC/approval flow and service identity in a separately approved
   device-local test session. Neither CORE nor ROOT overrides these checks.
5. Stage migration 0019 **before** deploying runtime code that issues new
   session IDs. A missing migration fails authentication/grants closed.
   No production D1 migration was applied in this PR.
6. Run full exact-HEAD GitHub CI and independent Final Acceptance/rollback
   before considering merge. This PR remains DRAFT; do not merge yet.

All unfinished items are explicit blockers; no interface should claim that
Admin Bridge has actually switched modes or that ROOT has Windows elevation.
