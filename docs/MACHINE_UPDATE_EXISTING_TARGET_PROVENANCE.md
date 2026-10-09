# Reject unverified existing machine update version trees

A downloaded Windows release ZIP can pass SHA-256 verification even while a previously created `C:\ProgramData\Nexowire\versions\<buildId>` directory contains unrelated/stale or locally modified JavaScript. Before this change `extractVerifiedRuntime` accepted such a directory if `runtime/node.exe` and `app/dist/src/cli.js` merely existed; on a target rename collision it used the same check to declare the target valid. Changing its ACL afterward does not independently attest the file contents to the official release.

## Fail-closed source change

- The updater now performs a read-only lstat of the exact intended version root before staging. Only ENOENT means it may create a fresh verified extraction. Any already-existing file, directory or junction at the target refuses with `MACHINE_UPDATE_EXISTING_TARGET_UNATTESTED`; access errors also propagate rather than masquerading as absence.
- Recheck target absence immediately before promoting the freshly validated extracted release. A competing directory creation or rename collision must fail instead of being accepted based on `node.exe` and `cli.js` filename presence.
- Keep the official ZIP checksums, setup/build metadata, bounded download and extracted bytes, Windows path/alias filters, protected ProgramData ACL, signed native Node, staged imported code ACL, safe staging cleanup, and Hub/Broker task health checks.

## Compatibility decision

This is deliberately a fail-closed stopgap rather than publisher attestation. Repeating an update for a build ID whose version directory already exists is rejected, even when that directory was installed legitimately. A future independently verified, full-tree content digest/publisher manifest is needed to safely support idempotent installed-version reuse. Do not work around the error by renaming a live installed directory or deleting anything from a running elevated service.

## Test results

49/49 focused Windows tests PASS on work-pc after rebasing against main `a9331c9ca13ea6042cc809197b660723ee81a496`; npm typecheck and build PASS. Tests cover absent target, existing directory, existing file, altered `node.exe`/`cli.js`, and source-level guards before staging and immediately before target promotion, plus all previous protected stage cleanup and ZIP / task preflight regressions.

## Live cutover boundary

This is source-only and does not change running tasks, processes, DPAPI/OAuth state, ACLs or installed application files. Live legacy Stack remains Highest with `Authenticated Users: Modify` on its CLI path. P0 #271 stays OPEN until independently publisher-approved complete code/updater provenance, true ordinary-token denied write, and administrator-authorized isolated Highest Task Scheduler/secret restore and rollback are verified.