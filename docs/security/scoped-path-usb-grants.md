# Scoped filesystem and USB volume permissions (P0, draft)

## Trust boundary

This branch introduces typed `read`, `write`, `delete`, `move`,
`recursive_delete`, and `usb_write` checks around the Agent's native file
operations. `PATH_DENIED` includes a reason, required permission and proposed
next step. The source of authority is the on-device `PathPolicy`; a remote
input must never mint its own grant.

Ordinary paths remain under `NEXOWIRE_ALLOWED_ROOTS` (default: Agent home).
The native Agent permits `read/write/delete/move` at those roots for
compatibility, but requires a separate explicit grant for recursive deletion.
Any recognized USB/removable Windows volume requires a matching `usb_write`
grant **in addition** to the ordinary operation scope. Volume identity
requires the storage volume UniqueId, disk UniqueId and partition number;
letter changes cannot by themselves confer access. If identity cannot be
verified, mutating operations fail closed. Raw disk, `GLOBALROOT`, UNC,
`\\wsl$`, drive-relative, ADS, and DOS device-name paths are denied through
native file tools. The policy never attempts to partition or format a disk.

### Locally approved grant model

`ScopedPathGrantRegistry.grantLocally` requires a target root, explicit scope
set, owner ID, Agent device ID, unique grant ID and positive expiration time
(maximum 24 hours for ordinary scopes, **15 minutes** for USB writes or
recursive deletion). Destructive grants cannot target the entire drive root.
A USB grant also requires the previously observed volume,
disk and partition identities. `revoke(id)` takes effect immediately;
expiration and Agent restart invalidate grants. Both wall-clock and monotonic
timeouts apply, so moving the wall clock backward cannot extend a grant.
Grant IDs cannot be reused without explicit revocation; grant inspections return
defensive copies. These records remain **in-memory**. The new Agent-side
`ScopedPathGrantAuthority` is exposed through `files.grant.status`,
`files.grant.request`, and `files.grant.revoke` (MCP `file_grant_*`). A remote
caller can *request* but cannot silently mint a grant. Windows grant requests
require an actual ALLOW decision in an interactive active-console session;
process Session 0, headless, timeout, prompt failure and DENY fail closed.
The dialog displays resolved target, individual scopes, duration, Volume GUID,
Disk UniqueId and reason. The Agent performs read-only filesystem and volume
checks both before and after approval, including ancestor reparse checks.
FULL ACCESS does **not** bypass this separate console approval. The dedicated
`src/agent/scoped-path-grant-approval.ts#spawn` is an explicitly reviewed
**AI Screen launch-sink exception** (issue #402): it launches the fixed Windows
PowerShell executable with a trusted environment, hidden PowerShell console,
stdin-only user-supplied text, a maximum 90-second deadline and active physical
session check. Only the opt-in YES/NO Windows Forms consent dialog is permitted
on the owner's physical desktop. Unlike background AI Screen automation, this
is a user-visible authorization transaction, not generic GUI control. A new
entry is registered in `scripts/ai-screen-launch-sinks-baseline.json` and must
not be interpreted as proof that other launch paths are isolated. This route is
implemented in source and tested with mock console decisions, not deployed to
both live Agent 1.0.5 installations. A physically approved test is still
required. Loading unsigned grants from a writable path would be
self-authorizing, so there is no persistent grant shortcut.

**Outstanding for production:** Validate the physical on-device dialog under
actual user logon and remote MCP account/device ownership; add native
handle-based path/file identity pinning before destructive I/O. Grant issuance
rejects an unavailable session instead of pretending approval succeeded.

### Arbitrary execution is not a path sandbox

`shell.exec`, `wsl.exec`, `process.start`, `process.write`,
`task.graph.run`, `runbook.run` and `workspace.checks` are blocked by
`UNSANDBOXED_EXECUTION_DENIED` without a short-lived explicit execution lease.
Parsing PowerShell/CMD/Bash strings cannot impose a trustworthy filesystem
boundary. Even `*` roots do not enable arbitrary shell execution: they would
otherwise bypass the separate USB write permission. The actual Native Agent
constructs its policy with a scoped grant registry, so the boundary is enforced
by default. Standalone `new PathPolicy(roots)` callers keep the prior
unsandboxed execution semantics for compatibility. Such library-only policies
**must not** be used at an untrusted dispatch boundary. Library clients can
opt into strict enforcement with `enforceExecutionBoundary: true`.

For transitional on-device configuration, an Agent process may start with
`NEXOWIRE_UNRESTRICTED_EXEC_UNTIL` set to a timestamp at most 15 minutes in
the future (ISO-8601). It is accepted only on Agent startup, expires during
the session, and cannot be specified as a capability input. **It is a trusted
environment configuration override, not proof of physical owner approval.**
A future strict release should bind this override to the same physical-console
approval authority as scoped grants.

### Non-goals and blockers

- No format, partition, disk-image flashing, firmware change or live volume
  manipulation is performed by these changes or the tests.
- Read-only `Get-Partition`, `Get-Disk` and `Get-Volume` run through the
  pinned Windows inbox PowerShell executable and a restricted module search
  environment, rather than inheriting attacker-controlled PATH/PSModulePath.
  The installed system Storage module is imported by absolute path and the
  partition/volume identity is checked again before emitting an answer.
  Invalid/missing/mid-query-changed identities deny mutation. On the development
  Windows machine, the pinned probe returned C: metadata successfully even
  with intentionally poisoned subprocess PATH/PSModulePath. This is **not** a
  physical USB/drive-letter-swap acceptance test.
- `PathPolicy` denial is returned as `PATH_DENIED` with policy reason/scope.
  Real Windows filesystem ACL/token failures retain OS `EACCES` or `EPERM`
  and carry `OS_FILESYSTEM_PERMISSION_DENIED` attribution. A scoped grant
  never grants NTFS privileges.
- Destination-overwriting `files.copy` now requires `delete` on an existing
  file target or `recursive_delete` on an existing directory target. This
  matches the existing `files.move` overwrite requirement and prevents
  overwrites through a broader write-only scope.
- After a slow volume identity or grant check, the Agent canonicalizes the
  **original requested path** a second time. It returns
  `PATH_CHANGED_DURING_AUTHORIZATION` if a directory was replaced by a
  junction/symlink during that check. Deterministic temporary-directory tests
  demonstrate denial for both existing files and new-file creation. This is
  a **race narrowing only**, not an atomic security boundary.
- Canonical path and symlink checks reduce path-escape exposure, but pathname
  `realpath` + `fs.*` is not an atomic handle-based security guarantee.
  Junction/reparse replacement and drive reassignment between checks and I/O
  remain TOCTOU risks. Resolving all path components with Windows handles and
  rejecting reparse transitions is a **production blocker** for dangerous
  removable-media writes.
- A wildcard root still canonicalizes existing ancestors when creating files.
  A junction or symlink into a removable volume must be classified by the
  destination volume, never by the original drive-letter prefix.
- For a future native helper, Windows exposes `CreateFileW` with
  `FILE_FLAG_OPEN_REPARSE_POINT` and `GetFinalPathNameByHandleW`; these
  calls must be paired with handle-relative traversal, file-ID checks and
  safe revalidation before any destructive action. References:
  https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea
  and https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew.
- `Get-Disk` is potentially expensive for frequent file operations; any
  future cache must be invalidated by verified volume change, not only TTL.
- Other host-control capabilities, e.g. GUI input or privileged installer
  pathways, are separate trust boundaries. They must not be described as
  sandboxed merely because these native file/shell routes are guarded.
- Windows storage identifiers are system-reported fingerprints, not cryptographic
  proof of hardware authenticity. A malicious controller or virtual device
  may spoof them.

## Regression acceptance

Run on a safe developer checkout only:

```powershell
npm run typecheck
node --test --import tsx test/path-policy.test.ts test/scoped-path-grants.test.ts test/scoped-path-grant-approval.test.ts test/agent-executors.test.ts
git diff --check
```

Negative coverage: wrong owner, Agent ID, grant scope, expired/revoked grant,
volume ID, disk ID, partition ID, drive-letter reassignment, unavailable
volume, outside-user-profile path, raw disk namespace, UNC/WSL shares and
volume-root deletion. Baseline symlink/junction escape tests are retained.

**Draft PR exit criteria:** verify physical-console approval using a live
installed Agent under the correct interactive user session, implement
handle-based race resistance for mutations, run physical USB attach/detach and
letter-swap tests (only with explicit safe acceptance permission), and close
full Windows regression failures before declaring production safety. Existing
synthetic tests include consent refusal, grant revoke, USB serial/volume/partition
mismatch, junction retarget and directory-removal during a mocked approval.
