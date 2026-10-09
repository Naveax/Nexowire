# Protected machine update staging cleanup

The privileged Nexowire machine updater creates a uniquely named staging directory below C:\ProgramData\Nexowire\update. Before this change it removed the staging directory only after successful promotion and ACL hardening; a failed ZIP inspection, extraction, promotion or target ACL operation could leave partially extracted files and downloaded ZIP payloads on disk. Repeated failed updates could exhaust free space and leave obsolete code in staging.

## Source-only fix

- Validate a canonical, exact updater-owned random UUID stage path below the fixed C:\ProgramData\Nexowire\update parent. Reject a caller-selected path, UNC/device/alias/traversal, arbitrary sibling, path suffix, wrong build ID syntax, wrong fixed root or malformed UUID before permitting recursive cleanup.
- Put stage extraction, ZIP write, target promotion and post-promotion ACL hardening into a try/finally scope. Remove its owned stage subtree on normal success AND on any thrown error. A path rejection and full read-only protected machine tree/reparse/ACL check precede recursive removal.
- If the original update and the staging cleanup BOTH fail, surface an AggregateError preserving both causes. If just cleanup fails, propagate that error rather than claim successful staging.
- Keep existing official SHA-256 manifest checks, streamed compressed/decompressed caps, ZipArchive path validation, detached task plan and listener-PID checks unchanged.

## Work-pc verification

46/46 focused Windows security tests PASS after basing on merged main c9a8adc86ea156ef640c3fca515cf097cabfbe64. New tests cover exact stage-path acceptance and rejection of wrong roots, arbitrary directories, traversal, aliases, suffixes and invalid random identifiers, plus structural verification of try/finally, safety rechecks and preservation of both failures. npm typecheck/build/git diff --check PASS.

## Limitations and deployment boundary

No live staging directory, Highest scheduled task, Hub/Broker service, ACL, DPAPI/OAuth secret or durable session was touched. Structural tests verify cleanup wiring, not a live injected I/O failure on the protected ProgramData root. The protected-tree scan is point-in-time; it cannot replace kernel-bound path handles or independent trusted publisher attestation. If the protected tree is unsafe, cleanup fails closed and requires authorized administrative remediation. Live P0 #271 remains OPEN.