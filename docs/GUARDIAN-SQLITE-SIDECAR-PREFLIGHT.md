# Guardian local SQLite rollback-journal sidecar trust check (source-only)

PR #356 added an inert SQLite EXTRA synchronous, rollback DELETE, one-time Guardian replay journal whose pinned Windows-only factory verifies its database file and parent directory ACLs. SQLite can also create or observe a sidecar file while recovering/writing. A protected database file **alone** is insufficient if an unexpected sidecar is independently writable by a lower-privileged user.

`auditGuardianSqliteSidecars` is a strict **read-only** file-type/ACL guard. For an already-provisioned trusted `replay.sqlite`, it:

- Optionally accepts a `-journal` file **only** if it is a regular file with independently verified private Windows owner/write ACL.
- Rejects any `-wal` or `-shm` files, which contradict the intentional `PRAGMA journal_mode = DELETE` configuration, even if their file ACLs appear private.
- Rejects symlinks/reparse-like nodes, unknown file types and inaccessible sidecar metadata rather than guessing they are absent.
- Returns only audit information, including `storageAttested:false` and `privilegedOperationAuthorized:false`.

The Windows-only production-oriented factory now invokes this check on its pinned database path inside its existing protected-directory assertions, before opening the database and again after a reservation. A generic injected ACL verifier is present only for disposable test fixtures; only the fixed path combined with real `verifyWindowsPrivateAcl` is intended as a production preflight.

**Limitations:** This does not eliminate filesystem hardlinks/NTFS race conditions, guarantee durable disk controller flush, verify the live privileged process identity, create or provision the Guardian database, or atomically transact with remote Cloudflare owner revocation. A file may change after the audit; a separately trusted service must retain protected handles and guarantee runtime integrity before actual OS actuation. P0 #271 remains OPEN.

No Guardian installation, Scheduled Task start/stop, file ACL mutation or Cloudflare/Agent/D1 production change occurs in this PR.
