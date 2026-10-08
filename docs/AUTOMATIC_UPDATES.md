# Windows hourly automatic updates

**Scope:** Windows Nexowire installation. Scheduled updates are **off until the official Windows setup registers** the user-level task, or the owner invokes `nexowire update auto install` from an installed release.

## Operation

- **Once per hour**, one Windows Scheduled Task named `Nexowire Automatic Update` checks the latest *published stable* GitHub release. It also checks once after interactive logon. It does not poll every few seconds, start when a version is unchanged, or create multiple running instances (`IgnoreNew`).
- Task principal is the **current interactive Windows user / Limited**, not SYSTEM or an elevation bypass. It uses a pinned `runtime/node.exe` and `app/dist/src/cli.js` in the same versioned install, with no bearer token in task XML. No `runas` or interactive `consent.exe` is used.
- On a newer release, the updater requires a healthy, previously authorized **elevated Nexowire Privileged Broker** on loopback 43112 with a same-user DPAPI token. Without it, **no cutover is performed**. It records a `broker_unavailable` outcome, rather than opening a UAC dialog, silently falling back to user-only updates, or claiming success.
- For an eligible published release, it checksum-verifies the official ZIP and setup, extracts a **side-by-side version** and invokes the broker's narrowly scoped `nexowire.machine_update.apply` operation, then schedules the user-side cutover. The existing machine/user helper scripts retain old launcher backups, check service/process health, and attempt rollback on failure. The auto-status `update_scheduled` explicitly means **post-cutover verification is still pending**.
- On a successful user-side cutover, the update launcher is patched to the new versioned runtime, preserving executable suffixes; on failure the previous launcher is restored.
- A create-exclusive lock prevents overlapping scheduled/manual **auto** jobs. A pre-existing lock is a safe skip and requires inspection; the updater never deletes an unknown lock. Check status without downloading or modifying services.
- On initial Windows user setup, registration is automatic and uses only the user's normal privileges. The installer smoke test replaces task registration with an inert local test marker so CI does **not** install host tasks.

## Owner commands

```powershell
nexowire update auto status
nexowire update auto run
nexowire update auto disable
nexowire update auto install
nexowire update auto uninstall
```

Run these from the **installed release**. A source checkout is not an eligible installation path for registering the task. `disable` prevents further scheduled checks without deleting status or launcher history; `uninstall` removes only the dedicated scheduled task.

## Boundaries and remaining acceptance

This makes **Nexowire's own updates** non-interactive *after* the Broker has been legitimately authorized. It **does not** circumvent Secure Desktop UAC, automatically approve arbitrary external installers, or grant unrestricted SYSTEM execution. The screenshot's third-party installer `consent.exe` prompt needs a separately authorized, narrowly scoped elevated execution workflow; automating clicks on UAC is not a supported solution.

Only an explicitly authorized, immutable, published release is installed; no development branch, candidate ZIP or unauthenticated manifest is auto-executed. GitHub TLS + co-published SHA-256 provide transport/bundle integrity, **not independent cryptographic publisher authentication**; production signature/attestation enforcement remains a separate release gate.

The installed production runtime remains v1.0.4 on work-pc and v1.0.3 on Naveax until a deliberately authorized official rollout. Until then, this new automatic-update task exists only in source/candidate packaging, not as a live deployed v1.0.5 feature. Live after-install checks must verify the hour trigger, at-logon recovery, single instance, broker fail-closed mode, rollback, and actual user+machine version parity. It must not be called FINAL before those tests pass.
