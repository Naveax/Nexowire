# Machine update protected cutover target validation

The official Windows machine update tool writes Hub Boot and privileged Broker task launchers to reference a new release runtime. Previously the exported cutover renderer accepted targetRoot without comparing it to the requested version/build identity and the one trusted machine update staging directory.

## Source changes

- Before any cutover script is generated, validate version and build ID using the existing official update parser and require their exact canonical representation.
- Require targetRoot to equal the exact Windows version path C:\ProgramData\Nexowire\versions\<version>-<12-hex-build> for that version and build ID, independent of host OS path separator.
- Reject unexpected case aliases, trailing separators, relative paths, UNC/device paths, other drives, profile folders, dot-dot traversal, mismatched release folders and nested descendants.
- Reuse the already-validated canonical targetRoot for the PowerShell $NewRoot string. Keep existing Hub/Broker task names, original staged release hash checks and rollback rendering unchanged.

## Verification

Windows work-pc ran 11/11 targeted tests covering the new target guard, protected ProgramData root rejection, trusted machine updater executable selection, and existing cutover/rollback contract. TypeScript typecheck/build and git diff validation passed.

## Security limitations

Canonical string validation does not validate the content of the target runtime, the independently trusted publisher identity, effective low-privilege filesystem write denial, parent directory ownership, reparse points/junctions or post-check races. A full protected runtime verification is still required before any live elevated Stack migration. This PR is source only. No live task, identity secret, file ACL, service or durable session is modified.