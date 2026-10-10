# Machine cutover: launcher runtime root consistency

The elevated machine cutover patcher previously treated any launcher script containing the new version root as already updated. That substring could exist only in a comment or unrelated setting, while the real Node executable and CLI in the launcher still pointed to the old runtime. The original rewrite also selected the first arbitrary version-path token in the entire script, without requiring Node and CLI to belong to the same trusted version.

## Source-only fail-closed check

- Bound the machine launcher text to 64 KiB before parsing and before any backup or write.
- Find all versioned Nexowire runtime root occurrences and require exactly one distinct version root, preventing comments or mixed-version script commands from masquerading as a consistent launcher.
- Require the root to reside under fixed C:\ProgramData\Nexowire\versions. Both root\runtime\node.exe and root\app\dist\src\cli.js must exist as exact references in the launcher text before allowing a no-op or replacement.
- A launcher already referencing the correct versioned runtime is not backed up or rewritten only after these checks pass.
- For an older but consistent root, prepare the entire replacement in memory; validate that it contains both expected new Node and CLI references before backing up the original and writing the new content.
- Preserve existing task identity/owner and exact scheduled action checks, listener PID/executable/CLI identity, rollback error reporting, signed staged runtime and root ACL gates.

## Real work-pc verification

28/28 targeted Windows tests passed, including actual isolated Windows PowerShell editing of disposable Hub and Broker launcher files. Both valid launchers were updated with backups. Already updated valid launcher remained untouched. A new-root comment with old runtime, mixed executable/CLI roots, missing expected CLI, untrusted C:\Users\Public root, and oversized launcher were rejected without modifying or backing up the disposable fixture.

npm typecheck, build and git diff --check passed.

## Remaining limits

This checks expected launcher references, but is not a general proof of arbitrary PowerShell launcher semantics. Complete publisher-controlled template integrity and OS ACL protection, effective ordinary-token write denial, and authorized real Highest Task/credential rollback remain separate production requirements. Nothing in the live Stack, Hub, Broker, machine launchers, credentials, ACLs or sessions was changed. P0 #271 remains open.