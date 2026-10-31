# Nexowire Agent maintenance candidate after released v1.0.8

**STATUS: DRAFT / SOURCE-ONLY / NOT RELEASED / NO LIVE DEPLOYMENT.**

Latest public release is v1.0.8 (2026-10-30). This candidate is a
minimal **proposed v1.0.9 patch** for #974 and #1001. It excludes CORE
#980/#985/#996, Connection Core #1003, persistent enrollment, protected
permissions, external Cloudflare access and all production CORE activation.

## Exact code inputs

- Main published-source baseline: `a19a228dc6f19fd484cf935e941a00ea625233f8`
- AI-01 WAL #986: `b5ff33a77af931edcd6c64ef41ca2114eeb2a037`
- Agent journal-owner #1002: `bce2dbdfca93d3537657c37e15d9248f17106a8a`
- The 15 modified/added source and test paths are **disjoint** across
  #986 and #1002; exact Git blobs are taken unchanged from those HEADs.
- The merge commit has both source HEADs as additional parents, without
  modifying the owner branches or deleting DB/WAL/SHM. A clean file-level
  composition does **not** establish runtime compatibility.

## Required release gates

1. Verify the full exact-head CI, including Windows real process-incarnation
   readback, no live-owner takeover, legitimate WAL recycle, crash/restart,
   UNKNOWN no-replay and CI release-readiness package tests.
2. Inspect only candidate signed Windows ZIP, Setup.cmd, release manifest,
   SBOM and SHA-256 checksums; check exact tree/build attribution. These
   artifacts are **not** automatically installed or promoted to stable.
3. In owner-approved isolated Windows VM test clean upgrade, service
   recovery, repeated Agent restarts, legitimate WAL recycling, live PID
   contention, read-only diagnostics and rollback preserving all tombstones.
4. Only after independent owner-approved physical acceptance may a
   maintenance release be approved. No journal reset/checkpoint/deletion,
   owner identity edit, UAC/ACL/credential mutation or CORE-enable shortcut.
5. Keep issues #974/#1001 open until an exact **installed** release passes
   the demonstrated two-device restart/recovery checks.

## Separate integration track

The 19-PR CORE rehearsal #995 is not a dependency of this maintenance
candidate. CORE source composition and protected native execution have
their own fail-closed gates. No production CORE permission is implied.

**GO/NO-GO: maintenance candidate pending CI and Windows tests; CORE NO-GO.**
