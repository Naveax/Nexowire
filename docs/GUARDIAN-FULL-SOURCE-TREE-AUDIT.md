# Independent Bridge Guardian complete-source-tree audit (source only)

The earlier Guardian source preflight validated only the fixed launcher `C:\ProgramData\Nexowire\bridge-guardian\launch.ps1` and its ancestor directories. A separately installed elevated Guardian can still be compromised if an imported or dynamically loaded **nested dependency** is user-writable while the launcher is locked down.

`auditBridgeGuardianFullSourceTree` implements a **separate, read-only** maintenance/installation acceptance check: it pins the Guardian source root, invokes the existing exact launcher/ancestor audit, then recursively inventories every nested regular file/directory with Windows owner/write-ACL verification. Any missing/unreadable path, untrusted write permissions, junction/symlink, unexpected node, excessive depth or more than 12,000 objects fails closed. It uses the existing already-reviewed full-tree walker; no new generic filesystem traversal is added.

The result explicitly sets `deploymentAttested:false`, `processIntegrityAttested:false`, `remoteActuationAuthorized:false`. Unlike continuous per-command validation, this potentially expensive tree scan is deliberately **not** wired into operational command or SQLite replay transaction paths.

**Limitations:** this is not a code publisher/signature check, not proof that a protected process is genuinely executing the scanned files, not a complete resolved module dependency graph (imports outside the fixed tree are not covered), and not a defense against hardlink alias or post-check filesystem races. It cannot replace securely attested installation, owner-approved protected Guardian lifecycle, unforgeable Hub transport, local OS evidence or independent security issue #271 remediation.

Local tests use disposable mock trees to verify nested-write ACL denial and symlink rejection. Nothing is installed on production Windows and the live device's ACLs, tasks, files, Worker and D1 remain unchanged.
