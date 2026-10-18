# Windows Job Object production trust QA

Date: 2026-10-18. Issue #541 is closed, PR #559 is merged. **Neither fact
establishes production acceptance.** This follow-up is source-only.

## Proven threat and mitigation

1. The prior JS launcher verified only `fs.stat(...).isFile()`, so an
   EXE swapped at the pinned path could forge `NWJOB3 PID FILETIME` and
   create an unmanaged process. No live-device exploitation is alleged.
2. The new launcher rejects missing/invalid SHA-256 build baselines,
   file-content substitution, symbolic-link and realpath redirection, or
   changed file identity between local checks. The build script now emits
   the digest and packaging includes it.
3. A new random `Local\\Nexowire-<uuid>` named Job is created per
   operation with `KILL_ON_JOB_CLOSE`. The native helper creates the
   root **suspended**, assigns it, and publishes `NWJOB4 PID FILETIME`.
4. The JS side independently invokes Windows kernel APIs through a
   system PowerShell P/Invoke probe: `OpenJobObject`, `OpenProcess`,
   `IsProcessInJob`, `GetProcessTimes`,
   `QueryInformationJobObject(JobObjectExtendedLimitInformation)`.
   The root's real creation FILETIME, Job membership, `KILL_ON_JOB_CLOSE`
   and absence of `BREAKAWAY_OK/SILENT_BREAKAWAY_OK` are checked.
   **Only after successful verification** does JS publish the per-launch
   release gate; the helper cannot resume before it opens that gate.
5. If any validation fails, the launcher kills **only its newly spawned
   guardian**. A verified OS Job then reaps associated synthetic members.
   Unconfirmed status remains unconfirmed, not success.

## Publisher and release gate

**Important limitation:** a build-created `.sha256` file is not a
protected release manifest. An attacker able to replace both the EXE
and manifest could defeat this checksum. The two path/stat checks
reduce ordinary substitution but do not provide a fully atomic
file-handle-to-executed-image guarantee.

The Windows bundle builder now refuses **tag-scoped** production builds
unless `NEXOWIRE_WINDOWS_JOB_PUBLISHER_THUMBPRINT` is configured to a
40-digit trusted certificate thumbprint and
`Get-AuthenticodeSignature` reports `Valid` with the exact thumbprint.
The current source-built Zig/MSVC developer helper is **unsigned**. It
is suitable for isolated tests, **not** a tagged production release.
PR bundle smoke remains a staging artifact, not production signing
evidence.

The final production solution still needs a protected/signed helper
manifest with version/rollback binding, an installer integrity ACL or
equivalent protected trust anchor, and a validated image/file-identity
link across process creation. Do not use this PR as release approval.

## Windows physical results (dedicated Work PC worktree, no live Agent changes)

- Combined targeted ProcessManager, guard-crash, synthetic Agent crash,
  durable worker crash, streaming I/O and trust negatives: **10 PASS,
  0 FAIL, 1 SKIP** (symlink privilege absent).
- Independent 128-session retention/reclaim physical run:
  **1 PASS, 0 FAIL**.
- Prior first attempt detected a release-gate temp-directory lifetime
  race. Temp directory lifetime now follows guardian close; positive
  streaming tests passed afterward.
- All terminations are limited to isolated fixture processes with
  unique markers and PID/creation evidence. No other Work PC user
  processes or installed services were targeted.

## Separate acceptance blockers

## Physical reproduction: second read-only named Job handle (BLOCKER)

2026-10-19, isolated Work PC fixture
`test/windows-job-named-handle-caveat.test.ts` +
`test/fixtures/windows-job-hold-query.ps1`: **1/1 PASS**.

- Launch a new Job guardian + uniquely marked PowerShell/Node synthetic
  process through ProcessManager.
- Independently verify the fixture guardian PID, command-line marker,
  Win32 creation timestamp and unique `Local\\Nexowire-<uuid>` Job.
- Open a second `JOB_OBJECT_QUERY` handle in a separate, **test-created**
  PowerShell process. Force-stop only the identity-verified synthetic
  guardian PID with `taskkill /PID`; **the Job root stays alive** despite
  `KILL_ON_JOB_CLOSE`.
- Close only the synthetic query handle; the root is then terminated by
  the final Job handle closure. The test asserts that the root is gone.
- The test illustrates a security gap, **not** a production-ready solution.
  A redesign of the Job naming/handle ownership or an equivalent trusted
  lifecycle control is required to close this blocker. Normal parent death
  now calls `TerminateJobObject`, but an involuntary guardian kill cannot
  execute that code.

- A named Windows Job can be reopened with query rights by another
  process. A second Job handle can delay `KILL_ON_JOB_CLOSE` if the
  guardian is **forcibly killed** rather than exiting through its owner
  death/error path. Normal parent-loss and accounting-error branches
  explicitly `TerminateJobObject` before closing handles, but a true
  involuntary guardian crash plus an externally retained handle is still
  a BLOCKED physical acceptance and threat-model gate. The word
  "sole" must not be used for named Job handles.
- Nested-host Job limitations and incompatible parent Job behavior not
  exhaustively tested with independent hostile parent fixtures.
- Explicit and silent breakaway are disallowed on the owned Job, but
  Windows COM/WMI/UAC/elevated broker processes outside the Job may not
  be owned. No comprehensive out-of-Job descendant telemetry exists.
- Full Agent cold restart/sidecar reattach on the **installed** live
  Agent, publisher validation, signed/protected release manifest,
  long-duration soak, power failure and privilege-denied variants are
  **not physically accepted**.
- `treeOwnership=windows_job` describes the verified root and
  processes actually in the Job. It is not proof of all possible
  broker-created descendants. Report unmanaged external side effects
  as `unconfirmed`, never as cleaned.

Do not merge this draft or deploy a new Agent solely because its
source/CI tests pass.
