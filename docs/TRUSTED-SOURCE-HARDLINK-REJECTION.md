# Hardlink-safe source and SQLite preflight (source-only)

The earlier Windows read-only privileged Stack and Guardian checks rejected reparse/symlink nodes, checked private owner/write ACLs and recursively inspected source. An NTFS hardlink is **not a symlink**: two filenames can refer to the exact same file identity, so a second name in a different directory can be overlooked by checks of the first path.

The updated source-only preflight fails closed when `lstatSync(...).nlink !== 1` on any executable/source **file** in the Stack full-tree inventory or on the canonical elevated `cli.js` entrypoint; the independently protected Guardian launcher and all files in the Guardian full-source-tree inventory are protected by the same rule. The production-oriented Guardian SQLite replay database and journal/WAL/SHM sidecars also reject non-single-link files rather than trusting their ACL alone. This check does not mutate existing files or unlink any alias.

Isolated Windows test fixtures create actual hardlinks with `fs.linkSync` to source and rollback-journal files. Tests verify immediate rejection even when a mocked ACL verifier accepts both names, alongside existing no-symlink, full-tree, SQLite concurrency, startup and fallback checks.

**Important limitations:** `nlink === 1` is a necessary defensive signal, NOT proof that the directory cannot be renamed or changed by a lower-privileged account and not a defense against arbitrary out-of-tree dynamic imports, publisher spoofing, NTFS reparse/TOCTOU races or insecure loaded dependencies. `verifyWindowsPrivateAcl` must still validate parents and every loaded file. Actual elevated process provenance and Task Scheduler security still need independent attestation. Hardened private installation and release cutover are separate owner-approved work. Live P0 [#271](https://github.com/Naveax/Nexowire/issues/271) remains OPEN: the production elevated Stack still loads writable source files.

No production Agent, Guardian, Windows Scheduled Task, ACL, Cloudflare Worker or D1 value is changed by this PR.
