# P0 #271: read-only full Stack dependency-tree ACL inventory

Issue [#271](https://github.com/Naveax/Nexowire/issues/271) remains OPEN because a live elevated `Nexowire Stack` Windows Scheduled Task currently runs a program rooted at `C:\ProgramData\NexowireStack\nexowire\node_modules\nexowire\dist\src\cli.js` while the runtime source inherits `Authenticated Users: Modify`. A seven-path-component ACL check (PR #333) is not enough to prove that every JS module imported by that elevated entrypoint is protected.

`src/security/privileged-stack-tree-audit.ts` adds a separate **read-only** dependency-tree inventory. It:
- First verifies the exact pinned current elevated entrypoint and seven-path chain.
- Recursively enumerates files and directories rooted at the exact `C:\ProgramData\NexowireStack`, checking each entry's own Windows owner/write ACL with the existing pinned Windows ACL verifier.
- Rejects symlinks/junction-like filesystem links and other nonregular nodes rather than following redirects outside the expected tree.
- Fails closed on missing/unreadable entries, unsafe ACLs, excessive depth/path length or more than 150,000 items; it does not silently skip subtrees.
- Outputs only aggregate counts and explicitly `runtimeAttested:false`, `modificationsPerformed:false`.

This scanner **does not remediate ACLs, stop tasks, modify files, install the protected independent Guardian, or prove executable publisher signatures**. Hard-link aliases, races between scan/execution, dynamically resolved modules outside the scanned tree and Windows task command-line identity require further verification. Traversing a large dependency tree and checking each ACL can be expensive. It is not run continuously or as a precondition on every Bridge ON/OFF request, and was **not run on the live production device**.

The separate generic filesystem-walker helper supports disposable test fixtures but is not a production trust assertion because its ACL checker is injected. Only the fixed-root wrapper uses the real Windows private-ACL verifier. The P0 issue must not be closed until a privileged owner-approved secure cutover has eliminated writable elevated source, the full dependency graph and task action are independently validated, and rollback/availability behavior is accepted.

No live machine changes or production Cloudflare/D1 deployment occur in this PR.
