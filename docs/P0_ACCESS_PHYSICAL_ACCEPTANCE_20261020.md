# P0 Access Control Physical Acceptance Matrix
Date: 2026-10-20 (Europe/Istanbul)
PR: #574, DRAFT, not authorized for production deployment.

## Evidence labels

- **TESTED (isolated)**: observed on temp fixtures or tests. NOT the installed service.
- **OBSERVED (read-only)**: actual Windows task/filesystem inventory from low-privileged device access.
- **BLOCKED**: required independent privileged identity/ACL proof missing or denied.
- **NOT TESTED**: no authorized physical execution; no claim of success.

## Actual device evidence (read-only)
| Gate | Naveax | Work PC |
| --- | --- | --- |
| Broker scheduled task | OBSERVED: Running | OBSERVED: Running |
| Bridge Guardian scheduled task | NOT OBSERVED | NOT OBSERVED |
| `C:\ProgramData\Nexowire\privileged-broker` | Exists | Exists |
| `Get-Acl` current call | BLOCKED: Unauthorized/unreadable | BLOCKED: Unauthorized/unreadable |
| Prior broad write | Prior read-only report: Authenticated Users Modify | No trusted current ACL proof |
| Broker/Guardian publisher+file SHA | BLOCKED | BLOCKED |
| UAC, task elevated identity, true OS token | NOT TESTED | NOT TESTED |
| Production AUTO/ON/OFF postcondition | BLOCKED | BLOCKED |

**Do not infer ACL safety from UnauthorizedAccessException.** A Running Broker
task is not proof of code integrity, installer signing, source ownership, or
permission to mutate Windows.

## Isolated Windows ACL, code-path and signer negative acceptance

`scripts/test-isolated-broker-source-evidence.ps1` creates only a randomized
OS temp fixture; it accepts no caller-supplied path and deletes the fixture.

1. An unsafe inherited `Authenticated Users: Modify` ACE on an isolated parent
   is observed on its source directory, updater, launcher and dummy binary.
   This demonstrates DACL propagation, not trustworthy production effective
   access. The tester also owns the temp files.
2. Parent write, updater edit, launcher edit and binary replacement change the
   fixture's byte-level SHA-256 identity, so pinned source digests must reject
   them. This is negative file mutation evidence, not production signature attestation.
3. `Get-AuthenticodeSignature` on unsigned dummy binary is not accepted.
   A real valid Microsoft-signed system PowerShell binary is NOT the separately
   required OpenJS Foundation publisher. Signature status alone is insufficient.
4. `scripts/test-isolated-broker-acl-rollback.ps1` protects and restores only
   the original temp fixture DACL in both normal and injected-failure scenarios.
   It retains current test-user rights for rollback; it is NOT a protected
   production installer and must not be repointed to ProgramData.
5. Protected runtime source already uses read-only pinned Node publisher,
   protected source-chain ACL and file identity guards. These source guards
   must be checked at deployment with independent authority; no fixture
   supplies such authority.

## Policy and execution negative acceptance

| Policy | Isolated proof | Actual device proof |
| --- | --- | --- |
| ROOT per-login SID, strict 15-minute maximum, logout revoke, replay/TTL | D1/SQLite + session tests | BLOCKED (not deployed) |
| ROOT wrong account, different session, SAFE, offline, re-pair | Negative tests | BLOCKED |
| CORE revocable owner preference, SAFE/OFF cancel, never OS token | Test coverage | BLOCKED |
| Guardian missing/untrusted source, SID, principal, paired owner, signed intent, replay | Guard/receipt negative tests | BLOCKED (Guardian not observed) |
| AUTO recovery, ON authenticated healthy process, OFF no task/process/listener | Protected collector synthetic tests | BLOCKED |
| UAC/physical console/Windows token separate | Fail-closed policy tests | NOT TESTED |
| `Authorization Explain` ROOT `policyActive` versus lease unexpired | Diagnostic tests; offline lease remains diagnostic | NOT DEPLOYED |

## Required authority and production gates

1. **P0 #271**: Independently authorized, elevated, read-only ACL audit of
   protected parent, Broker source root and every updater, launch script,
   node executable, manifest, file and replaceable ancestor; explicitly check
   inherited effective ACEs, DELETE_CHILD, owner, WriteDac, reparse/hardlinks.
   Current low-privilege access cannot provide that proof.
2. Authenticode publisher/chain and exact pinned executable+source hashes and
   actual scheduled-task action/principal SID under a protected observer.
   Check after installation and immediately before authorized operations.
3. Install/enroll independent protected Guardian, keeping it reachable while
   Broker is OFF. Require signed owner intent, paired current device binding,
   revocation and durable replay checks. Do not enable production transport
   while source integrity remains BLOCKED.
4. Separate authorized physical UAC/console/token test and OFF→ON→AUTO
   postcondition/rollback acceptance. No running task changed during this work.
5. Secure D1 migration before the login-bound ROOT runtime is deployed.
6. New exact-head GitHub CI must pass; keep #574 DRAFT even if CI is green
   because physical P0 gates remain BLOCKED.

No production ACL write, task restart, service control, forced token escalation,
main merge or deployment was performed.
