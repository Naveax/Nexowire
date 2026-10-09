# Protected machine updater ProgramData root boundary

The official machine updater stages downloaded release payloads, rewrites machine Hub/Broker launchers and may recursively alter filesystem ACLs. Previously its root was built from process.env.ProgramData, which is caller-controlled, and the same path was used to render a detached privileged cutover script.

## Source changes

- Resolve privileged machine update roots only to C:\ProgramData\Nexowire. A caller-supplied ProgramData value is permitted only when it canonicalizes exactly to C:\ProgramData and uses an explicit drive-letter absolute Windows path.
- Reject relative, drive-relative, current-drive rooted, UNC/device, alternate-drive, parent traversal and user-selected ProgramData paths. The rule is applied both when preparing the actual staging path and when rendering the cutover/rollback script.
- Existing official version/build-id validation, release checksum checking, task launcher selection and rollback behavior are unchanged. This change does not itself run an update.

## Windows verification

On work-pc 4/4 focused regression tests passed for malicious ProgramData overrides and existing cutover/rollback rendering. TypeScript typecheck/build and diff check passed. A discovered Windows path edge case (current-drive rooted \ProgramData) was explicitly rejected after the first test caught it.

## Limitations

An exact string-normalized ProgramData root does not prove that the actual C:\ProgramData\Nexowire directory or any descendant is ACL-protected, not a junction/reparse point, or free of time-of-check/time-of-use races. That requires separate lstat/reparse and effective rights verification plus a tested privileged rollback. Checksum assets from the same release are not independent publisher approval. P0 #271 remains open; no live Highest Stack cutover is authorized.
