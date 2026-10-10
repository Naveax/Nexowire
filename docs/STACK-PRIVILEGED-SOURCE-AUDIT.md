# Elevated Nexowire Stack executable source audit (P0 #271)

The currently observed privileged `Nexowire Stack` task uses the entrypoint:

`C:\ProgramData\NexowireStack\nexowire\node_modules\nexowire\dist\src\cli.js`

**Known production blocker (#271):** prior read-only inspection showed inherited **Authenticated Users: Modify** access to this privileged executable source. Such a file must not be executed at High integrity until a separately authorized and backed-up secure cutover is completed.

`auditPrivilegedStackSource()` is a **read-only, fail-closed preflight**, not a repair function. It:
- Enforces the exact known canonical Windows path; rejects UNC, alternate streams, relative segments and similar-looking sibling directories.
- Walks from `C:\ProgramData\NexowireStack` through all nested directories and the final file.
- Uses `lstatSync()` and rejects a symbolic link/junction or unexpected file/directory type at every component.
- Calls the existing `verifyWindowsPrivateAcl()` on every path component; untrusted ACL owners or non-system/non-administrator write permissions fail closed.
- Returns an audit result **only** after all path components verify; otherwise throws without modifying files.

The current implementation does **not** inspect a registered Scheduled Task's actual principal/action or attest that its command points to this path. A complete production cutover must separately prove scheduled-task identity, canonical command/executable, launcher and dependency integrity, signer/publisher, a suitable maintenance window, backup/rollback and normal user authorization. Changing ACLs blindly may leave an active service broken or create new vulnerabilities.

Nothing calls this function automatically during a production Agent update. It does not change live permissions, schedule tasks, deploy a Worker, stop services, or declare #271 resolved. Local focused tests verify canonical path checks and non-mutating behavior. The actual live runtime still requires its own controlled acceptance test.
