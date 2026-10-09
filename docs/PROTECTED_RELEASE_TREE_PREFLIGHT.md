# Read-only release package tree integrity preflight

P0 Issue #271; coordinates with protected Hub handoff Issue #265.

`scripts/verify-release-tree.ts` compares the staged `.tgz` **without extracting or executing it** against a previously extracted `package` directory. Supply an SHA-256 pin obtained from an independently verified release record, not blindly copied from the same mutable folder.

Usage:

```powershell
node --import tsx scripts/verify-release-tree.ts `
  'C:\Users\navea\NexowireWork\broker-stage-v105-20261008\nexowire-1.0.5.tgz' `
  'C:\Users\navea\NexowireWork\broker-stage-v105-20261008\SHA256SUMS' `
  'C:\Users\navea\NexowireWork\broker-stage-v105-20261008\package' `
  '1.0.5' `
  '<trusted 64-character archive SHA256>'
```

The optional sixth argument pins `dist/src/cli.js` by a separately known SHA-256.

### Checks

- tarball digest against the **separate pin** and exact canonical one-line SHA256SUMS entry; package archive name and package.json version/name/bin are checked
- tar/gzip size and entry bounds, tar header checksums, ustar format, regular files and directories only, no symlink/hardlink/special entries, traversal, Windows reserved names, duplicate case-insensitive member names or unexpected top-level paths
- extracted tree must be a real directory with ordinary files and directories only (no symlinks/junctions), case-sensitive matching paths, no missing, modified or extra files
- every byte is hashed; a sorted name/size/file SHA-256 inventory digest summarizes the complete matched code tree

### Complementary signed provenance gate

See docs/PINNED_RELEASE_PROVENANCE.md and scripts/verify-pinned-release-provenance.ts for read-only GitHub/Sigstore provenance pinned to a specific SLSA workflow, tag, source commit and archive SHA-256. Both gates are prerequisites only; neither grants privileged execution authority.

### Security boundary

A matching tree **does not prove the release is signed by Nexowire**, that the digest pin came from a trustworthy publisher, that the Node executable and dependency tree outside this package are trusted, that Windows ACLs prevent replacing it, or that any elevated task/secret is safe to migrate. `safeToElevate`, `codeSignatureVerified`, `protectedAclVerified`, and `authorizedInstallerVerified` intentionally remain `false`. This is a read-only prerequisite, not a trusted installer.

The already-running legacy v1.0.0 Stack retains unsafe ProgramData ACLs until separate owner-authorized protected installation and rollback. Never execute extracted user-staged code as SYSTEM or modify live tasks on the basis of a matching digest.