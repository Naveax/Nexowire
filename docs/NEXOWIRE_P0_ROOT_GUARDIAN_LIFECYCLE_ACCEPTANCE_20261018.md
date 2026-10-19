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

## 2026-10-19 follow-up: CI #39155386266 and reversible isolated ACL fixture

- Run `39155386266` exact-head `4ad35ab` **FAILED**:
  `test (24)` had precisely one source assertion failure in
  `test/console-ui-polish.test.ts`. The assertion expected misleading
  `ROOT izni açık` text, while the implementation safely states
  `ROOT bakım politikası aktif (Windows yetkisi ayrı)`. Updated the assertion
  to require the latter and forbid the former, without weakening privilege
  separation. `test (22)` was canceled and must run at the new exact HEAD.
- Created an **isolated, self-scoped Windows ACL setup/rollback fixture**
  at `scripts/test-isolated-broker-acl-rollback.ps1`:
  - Creates a random `nexowire-acl-fixture-*` directory under the OS temp root.
    The script takes no destination path. It never reads/modifies installed
    Nexowire sources, scheduled tasks, services or live Registry keys.
  - Seeds a dummy launcher with synthetic Authenticated Users Modify access,
    verifies that the bad write ACE is observable, applies an exact pinned
    SYSTEM/Administrators/test-user DACL, and checks removal of unsafe ACEs.
  - Restores the **original DACL exactly** for directory and file, then deletes
    the temporary fixture. Tests cover normal flow and injected failure after
    parent directory hardening. Nonzero exit on unverified restore/cleanup.
  - Initial prototype was **BLOCKED**: `Set-Acl` of full descriptors raised
    `PrivilegeNotHeldException` on the non-admin runner. Changed restoration
    to Access/DACL-only `Directory.SetAccessControl` /
    `File.SetAccessControl`. Both real isolated scenarios now PASS.
  - The fixture's private ACL retains the current test-user SID for rollback.
    **It is not a production protected install and cannot confer broker trust.**
    Production source must have independently verified SYSTEM/Administrators
    owner and ACL, publisher identity, binary hashes, and protected Guardian.
- On 2026-10-19, fresh read-only task inventory: both Naveax and Work PC have
  Broker task Running, and neither has a discoverable Bridge Guardian task.
  ACL query on both protected Broker roots was not readable by this account;
  current ACL is **UNVERIFIED**. An earlier authorized audit showed
  `Authenticated Users: Modify` on Naveax. Do not infer this has been fixed.
  P0 #271 and missing Guardian remain production BLOCKERS.
- ROOT logout/replay/token revocation, CORE SAFE/OFF revocation, Guardian
  owner/device/session/task/source verification, and mode AUTO/ON/OFF final
  postcondition tests remain fail-closed. No existing live service ACL changed.
- Never enable the production Bridge command fuse or merge to `main`
  solely because test runner CI passes. Exact-head CI must be independently
  verified for this follow-up commit, including formerly canceled `test (22)`.
