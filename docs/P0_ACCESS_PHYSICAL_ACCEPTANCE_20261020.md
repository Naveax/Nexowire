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

## 2026-10-20 evening follow-up: P0 #271 real native `icacls` and migration stage gates

**Read-only Windows inventory taken today, no ACL mutation:**

| Target | Exact authorized observation | Acceptance |
| --- | --- | --- |
| Naveax `C:\ProgramData\NexowireStack` | `NT AUTHORITY\\Authenticated Users:(I)(M)` and `(I)(OI)(CI)(IO)(M)` | **P0 UNSAFE / NO-GO** |
| Naveax `C:\ProgramData\NexowireStack\nexowire\node_modules\nexowire\dist\src\cli.js` | `NT AUTHORITY\\Authenticated Users:(I)(M)` | **P0 UNSAFE / NO-GO** |
| Naveax `C:\ProgramData\Nexowire\privileged-broker` | `icacls` exit 5, ACCESS DENIED | **BLOCKED / ACL UNKNOWN**, never safe by inference |
| Work PC `C:\ProgramData\NexowireStack` | path not found (icacls exit 2) | NOT APPLICABLE TO THIS DEVICE, not a proof about Naveax |
| Work PC ...`dist\src\cli.js` | path not found (icacls exit 3) | NOT APPLICABLE TO THIS DEVICE |
| Work PC `C:\ProgramData\Nexowire\privileged-broker` | `icacls` exit 5, ACCESS DENIED | **BLOCKED / ACL UNKNOWN** |

The `(I)` ACE is inherited and is an effective write entry on the Stack
directory and its CLI source. The second inheritance-only ACE propagates
non-admin modification rights to descendants. This directly invalidates
any claim that the existing elevated Stack's source chain is protected.
A denied broker DACL is **unknown**, not evidence of safety. Do not grant
additional tool permissions or escalate the current account to bypass this.

**New code, DRAFT PR #574 only:**

- `src/product/root-session-migration-preflight.ts` exports an explicitly
  **read-only schema-only staging** validator for migration `0019`. Verifies
  both required session tables, exact column shape and NOT NULL/PK, duration/hash
  checks, revocation/grant indexes with correct ordered columns, base lease
  table, and device FK CASCADE. Missing/partial/fake schema, absent required
  index, provider error or reverted table throw
  `ROOT_SESSION_MIGRATION_NOT_STAGED`, never a production-ready verdict.
- `test/root-session-migration-staging.test.ts` uses actual ephemeral SQLite
  to exercise pre-migration refused authentication/revocation/grant,
  successful post-migration read-only introspection, partial schema, missing
  indexes/tables, fake structures, tampered index order, missing lease shape
  and query failure. No remote Cloudflare D1 migration was applied or verified.
  Migration `0019` MUST be applied safely to an authorized staging binding
  before a production runtime rollout, followed by an independent recheck.
- `test/guardian-independent-attestation-negative.test.ts` verifies real
  Ed25519 possession signatures with current owner/device/credential/nonce,
  and compares a *synthetic* task snapshot/ACL callback with a signed bridge
  receipt. A positive key-possession check is **not authorized enrollment**,
  and an Ed25519-signed claimed `applied` receipt cannot independently
  establish physical task source integrity, Hub channel, native UAC, or
  privileged actuation. Revoked pairing, replayed challenge, rotated key,
  missing or forged source ACL and missing Guardian remain denied.
- Existing isolated Windows parent/updater/binary inherited ACL negatives
  remain scoped strictly to randomized temp files. They do not remediate the
  two actually unsafe Naveax Stack locations.

**Required external physical gates, still BLOCKED:**
1. Authorized installer/operator must separately remediate the actual
   inheritance at the protected parent and confirm protected source and
   updater/launcher/binary ownership, effective write/delete/replace rights
   including shared ancestors; isolate and stage rollback beforehand.
2. Reinspect actual Naveax + Work PC Broker ACLs with **authorized**
   read-only trusted Windows context, never assuming an Access Denied means secure.
3. Establish independent protected Guardian installation, current pairing,
   protected key provenance, signed enrollment, true process/task/source
   identity and separately authenticated Hub channel.
4. Apply `0019` through approved *staging* Cloudflare migration only,
   run read-only preflight against that staging D1, and verify migration
   sequencing before production worker activation.
5. Physical AUTO/ON/OFF healthy process/socket/task postconditions, owner
   confirmation and UAC/console approvals remain NOT_TESTED.

**Production verdict: NO-GO; no live ACL/service/UAC changes, no main merge.**

## 2026-10-21 #04 Access: conservative cross-PR review and VM-only rollback gating

PR #574 remains **DRAFT / SOURCE-ONLY**. PRs #551 and #576 were reviewed
against P0 #271; independent comments were posted to their actual GitHub
discussions. Their source CI success does not create production acceptance.

### Exact source review findings

- **#551 signed installer**:
  `scripts/s3-windows-acl-preflight.ts` performs a bounded read-only native
  ACL observation for roots plus ancestors/descendants, and
  `scripts/s3-release-bundle-audit.ts` invokes it on OFFLINE
  `target` and `rollback` directories. This is not an attestation of the
  later **installed live source/import graph** or updater paths outside the
  two offline subtrees. The result correctly says `executionSafe:false`
  and `productionApproved:false`. Independent post-cutover effective
  ACL, source hash, updater and running image proof remain missing.
- **#576 native Job trust**:
  `scripts/audit-windows-job-helper-trust.ps1` checks risky writers on
  `$acl.Access` (helper file). It reads `$parentAcl` but checks only
  `AreAccessRulesProtected`, rather than testing the parent ACL's explicit
  writable ACEs and separately protecting `windows-job-owner.sha256`.
  A parent can disable inheritance yet grant Authenticated Users Modify.
  The provisional file-trust summary must fail closed for such parent or
  manifest replacement opportunities. The script's final
  `productionReady:false` is correct and must remain so.
- Review requests posted on #551 and #576 without changing their branches.

### Added isolated validation in #574

- `src/security/access-acl-candidate-gate.ts`: intentionally
  **non-authoritative** candidate-only ACL evaluator requiring each of
  seven distinct role samples: private parent, updater parent, updater,
  launcher, broker binary, Job helper and helper manifest. It conservatively
  rejects non-SYSTEM/Admin write, append, delete child, DELETE,
  WRITE_DAC, WRITE_OWNER and generic write/all ACEs, including inherited
  entries, regardless of a separate Deny ACE. Rejects missing/duplicate
  chain, reparse, unknown owner/ACL, malformed rights, path and identity
  mismatch. It has no production authorization output. Even a locally clean
  sample returns `CANDIDATE_SAFE_ONLY` with
  `productionApproved:false` and `independentEffectiveAccessVerified:false`.
  There is **no elevated native effective AccessCheck proof** in this PR.
- `scripts/acceptance-access-vm-acl-migration.ps1`: operator opt-in
  `-AuthorizedVmFixture` and Windows virtual-machine model precheck
  *before* any ACL modifications. Calls the pre-existing random OS-temp-only
  harden-and-restore fixture for both normal and injected-failure cases,
  verifies DACL restoration and cleanup, and always returns VM fixture-only
  and production-denied results. A VM model string is **not** cryptographic
  hypervisor attestation; operator authorization still required. The VM
  workflow was **not run on an authorized VM**. The non-opted-in invocation
  was exercised on Work PC and correctly rejected before any ACL writes.
- `test/access-acl-candidate-gate.test.ts` and
  `test/access-vm-acl-migration.test.ts` include conservative inherited
  Modify/parent/updater/manifest/unknown-token negative tests and safe-deny.
  Local scoped suite 21/21 PASS; typecheck and build PASS. Existing
  root session, CORE, Guardian, Admin Bridge and D1 staging gates unchanged.
  No elevated physical ACL proof or actual D1 staging migration asserted.

### Physical P0 gates remain NO-GO

Naveax physical `icacls` evidence dated 2026-10-20 shows inherited
`Authenticated Users:(I)(M)` on both `C:\ProgramData\NexowireStack`
and `...\dist\src\cli.js`. Both physical Broker protected root
ACL queries returned exit 5 Access Denied: **UNKNOWN**, never safe.
Independent Guardian tasks and installed source have not been attested.
A separately approved elevated *read-only* observer, approved isolated VM
migration/rollback, native effective AccessCheck identity, publisher signing,
post-cutover updater/binary identity and UAC/Guardian gates are outstanding.
**NO live ACL/UAC/service/Task write, NO policy bypass, NO merge/deploy.**

### Prepared elevated read-only observer (21 October)

Added `scripts/audit-access-elevated-readonly.ps1`: requires an
already elevated administrator and high-integrity Windows token,
uses fixed known source paths and read-only `Get-Item` / `Get-Acl` /
SID-translated Allow ACE inspection. It DOES NOT trigger UAC, change ACLs,
start/stop services, or claim native AuthzAccessCheck. Refusal with a
non-elevated Work PC account was tested. An authorized elevated run has
**NOT** occurred. Any readable but untrusted writer, missing source,
AccessDenied, unknown parent/updater identity or incomplete import graph
preserves **P0 NO-GO**. The output always marks
`sourceCoverageComplete:false`, `nativeAccessCheckPerformed:false`,
`independentGuardianAttested:false`, `productionApproved:false`.

The separately prepared `acceptance-access-vm-acl-migration.ps1` also
remains NOT RUN on an authorized isolated VM: the physical test only proved
refusal without explicit opt-in. Neither betik confers security
attestation on installed `C:\ProgramData` sources. #551 and #576
cross-PR comments request actual parent/helper-manifest/installed-updater
coverage before any integration. No P0 release waiver exists.
