# Windows Job Object: independent production trust QA

Date: 2026-10-19. Merged PR #559 and closed issue #541 are **not**
production acceptance. This follow-up is isolated source-only work
on DRAFT PR #576. No installed Agent or main deployment was changed.

## QA incident and exact-source changes

- The original `NWJOB3 PID FILETIME` text marker and
  `fs.stat(...).isFile()` could be forged by an executable substituted
  at the nominally pinned path; independent OS ownership evidence was absent.
- Source-built helpers now ship a SHA-256 companion manifest, and the
  launcher checks the actual file digest, change of file ID/size/mtime,
  symlink/reparse leaf, and canonical parent/leaf relationship before
  starting. This **does not authenticate the manifest or eliminate a
  last-millisecond image replacement race**.
- Protocol **NWJOB5** (replacing provisional NWJOB4):
  `CreateJobObjectW(NULL, NULL)` creates an **unnamed** Job.
  The guardian creates the synthetic shell `CREATE_SUSPENDED`,
  assigns it, verifies its membership and creation FILETIME, and
  writes `NWJOB5 <pid> <FILETIME> <guardian-owned-handle>`.
  The new marker is only a query input, never proof of ownership.
- The launcher calls a **separate** Win32 verifier through system
  Windows PowerShell: `OpenProcess(PROCESS_DUP_HANDLE)` on the guardian
  PID, `DuplicateHandle` with `JOB_OBJECT_QUERY` from that exact
  guardian Job handle, then `IsProcessInJob`,
  `GetProcessTimes`, and `QueryInformationJobObject`.
  The root must have exactly the expected creation FILETIME and be
  a member of the duplicated Job; its limits must include
  `KILL_ON_JOB_CLOSE` and exclude breakaway options.
- Only after **all** checks pass does JS create the temporary
  verification gate allowing the suspended root to resume.
  The temporary directory survives until guardian exit; a transient
  verifier-query handle is closed in the verifier's `finally`.
  On failure the launcher terminates only its own spawned guardian.
- For normal owning-parent death or Job accounting failure, the
  guardian additionally calls `TerminateJobObject` before closing
  the Job handle. The existing `requested/unconfirmed` cleanup
  contract is preserved.
- ProcessManager reports verified **root at launch**, scope
  `job_members_only` and `outOfJobDescendants=unknown`; it does not
  claim arbitrary COM/UAC/WMI broker processes were contained.

## Historical named Job bypass and new fix

The initial provisional NWJOB4 design used the discoverable name
`Local\\Nexowire-<uuid>`. On 2026-10-19 an isolated Work PC
fixture held a second `JOB_OBJECT_QUERY` handle, then terminated
**only its own verified synthetic guardian**. The synthetic root
stayed alive until that extra handle closed, defeating an assumption
that guardian death always invokes `KILL_ON_JOB_CLOSE`. Physical
reproduction: **1/1 PASS**, source commit `34bb03b7490972036e256c87dab755a13e1e04c1`.

The replacement NWJOB5 uses an **unnamed Job**, preventing arbitrary
`OpenJobObject(name)` reopens. Updated test
`test/windows-job-named-handle-caveat.test.ts` verifies no public
name is advertised, the old query-only name-opening fixture cannot
attach, and killing the identity-verified synthetic guardian reaps
its root. **1/1 PASS on Work PC**.

**Remaining risk:** a process with sufficient `PROCESS_DUP_HANDLE`
access to the guardian may still duplicate the unnamed Job handle
and retain it. A privileged/same-user attacker who can replace both
the helper and companion checksum, or control the running guardian,
is *not* eliminated by this source-only redesign. A hardened
process-token/DACL boundary, release authenticity and image/handle
provenance remain production gates.

## Source validation, not staging or production

- Original synthetic guardian/Agent crash, durable-worker crash,
  stream piping, ProcessManager cleanup: see recorded test outputs
  on this PR. A previous full Work PC run passed **22/22 + 1 SKIP**.
- NWJOB5-specific start/stream tests: **2/2 PASS**.
- NWJOB5 negative helper/marker/publisher tests plus unnamed handle
  fixture: **4 PASS, 1 SKIP, 0 FAIL**; symlink creation is forbidden
  on the local Work PC account, while GitHub Windows CI can exercise
  it. These are separate runs and **must not** be combined as one.
- Tests only terminate fixture-created guardian/worker PIDs after
  exact PID+creation+unique-command-marker validation. User
  processes and installed Nexowire Agent are untouched.

## Publisher and production release blockers

The build-generated `.sha256` is not a signed/protected source of
truth: a substitute binary and substitute manifest can be matched.
The Windows bundle builder refuses tag-scoped releases lacking a
specific trusted publisher thumbprint and a **Valid** Authenticode
signer. The Zig/MSVC source-built development helper is unsigned
and is **not production-accepted**. Release manifest, certificate
chain, version/rollback-bound signature, protected install ACL,
image-locking/TOCTOU closure and runtime validation are pending.

### Other blockers

1. Hostile nested parent Job limits, explicit breakaway, access denial
   and out-of-Job broker launch variants still need independent
   physical tests. `job_members_only` is not blanket tree ownership.
2. Adversarial `PROCESS_DUP_HANDLE` retention and debugger/handle
   inheritance scenarios still need hardened Windows-native
   validation, not just an unnamed Job.
3. Physical installed Agent cold restart/sidecar reattach, recovery,
   publisher integrity and long-running soak are **separate** from
   source regression and hosted CI success.
4. Exact-head CI must pass; Release Readiness success alone cannot
   authorize production.

**Decision: PRODUCTION BLOCKED; keep PR #576 DRAFT.**
