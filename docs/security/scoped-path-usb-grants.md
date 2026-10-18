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
(maximum 24 hours). A USB grant also requires the previously observed volume,
disk and partition identities. `revoke(id)` takes effect immediately;
expiration and Agent restart invalidate grants. These records are deliberately
in-memory and are **not yet exposed to the remote MCP client**. Loading unsigned
grants from a path writable through file/shell tools would be self-authorizing,
so no such shortcut has been introduced.

**Outstanding for production:** Connect grant issuance and revocation to
authenticated local-owner/physical-console approval; show a volume fingerprint
and resolved target on that screen; optionally persist *integrity-protected*
grants with revocation and restart rules. Until then, USB mutation permissions
will be denied on the production Agent.

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
- PowerShell `Get-Partition`, `Get-Disk` and `Get-Volume` are used for
  read-only volume identity retrieval. Invalid/missing values deny mutation.
- Canonical path and symlink checks reduce path-escape exposure, but pathname
  `realpath` + `fs.*` is not an atomic handle-based security guarantee.
  Junction/reparse replacement and drive reassignment between checks and I/O
  remain TOCTOU risks. Resolving all path components with Windows handles and
  rejecting reparse transitions is a **production blocker** for dangerous
  removable-media writes.
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
node --test --import tsx test/path-policy.test.ts test/scoped-path-grants.test.ts test/agent-executors.test.ts
git diff --check
```

Negative coverage: wrong owner, Agent ID, grant scope, expired/revoked grant,
volume ID, disk ID, partition ID, drive-letter reassignment, unavailable
volume, outside-user-profile path, raw disk namespace, UNC/WSL shares and
volume-root deletion. Baseline symlink/junction escape tests are retained.

**Draft PR exit criteria:** implement a trustworthy on-device grant approval
route, handle-based race resistance for mutations, reparse-point tests on
Windows, and repeated attach/detach simulations before declaring production
safety.
