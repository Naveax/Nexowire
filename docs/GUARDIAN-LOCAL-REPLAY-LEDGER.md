# Guardian local replay ledger: fail-closed protected one-time marker

The Hub-side command claim is an atomic server record, but a future independent Windows Guardian must also refuse replayed signed commands after its own process restart. This source-only module implements a deliberately limited **local** one-use reservation primitive.

## Mechanism

`createGuardianLocalReplayReserve` uses a SHA-256-domain-separated filename derived solely from the validated request UUID (never a path provided by remote clients). It asks an independently trusted local reader for the CURRENT device ID, current credential binding, current owner preference revision and authorization, then uses `fs.open(..., 'wx', 0o600)` to create a marker exclusively. Exactly one simultaneous local process can create it. The marker stores only SHA-256 digests, not raw pairing tokens, device IDs or preference contents. It is synced to disk and never removed by the library. An already-existing marker, a partially written marker or a failed post-write ACL/revocation recheck cannot be reused. Further checks occur AFTER marker persistence, so an owner-preference change can consume a command but cannot mark it successful.

`createProtectedGuardianLocalReplayReserve` is a separate **Windows-only pinned wrapper**: it refuses uninstalled/unprotected paths, verifies the exact separately protected Guardian source/launcher ACL as well as the `C:\ProgramData\Nexowire\bridge-guardian\state` and ancestor ACLs, and checks the just-created marker ACL. No directory creation or ACL repair is performed. The generic directory+ACL callback exists solely to test the pure mechanism in disposable fixtures and does not establish trust.

## Important limitations

- **NOT a complete transactional Windows command ledger:** exclusive file creation is atomic across local processes and survives normal process restarts, but Windows directory metadata durability after sudden power failure is not attested by a file sync alone. A reviewed Windows transactional durable journal (or equivalent) is required before privileged OS execution can rely on this as its sole replay defense.
- A local snapshot read is NOT atomically coupled to Cloudflare D1 / owner preference revocation. It must be backed by a future authenticated Guardian/Hub transaction with fail-closed revocation checks.
- Having a protected directory does NOT prove that the current process is the trusted Guardian, that its Scheduled Task action is protected, or that its OS elevation is appropriate.
- No scheduling, broker start/stop, elevation, token handling, remote channel, live key enrollment or signing is supplied by this module. Current real production Guardian is not installed/attested.
- A marker can persist indefinitely; quota, operational maintenance and owner-approved cleanup require a separate protected policy. Automatic eviction would re-enable replay and is intentionally absent.
- P0 [#271](https://github.com/Naveax/Nexowire/issues/271) remains open; do not enable live ON/OFF just because these isolated tests pass.

Tests cover concurrency, restart, revocation before/after exclusive creation, untrusted directory or marker, malformed identity, and missing protected paths. All production machines remain unchanged.
