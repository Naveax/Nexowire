# v1.0.9 AI-04 controlled cutover disk recheck — 2026-11-19

## Source scope

Parent #1160 exact HEAD: `fbcc9b4326044617eb21efd405da027f076dcca2`. This is a source change to **future, explicitly approved** controlled SYSTEM Hub migration. It does not initiate a live migration, stop the interactive Hub, modify Scheduled Tasks, change Broker authority, or touch DPAPI/SQLite protected state on Work-PC.

## Read-only gate

- `src/hub/system-cutover-disk-reserve.ts`: measures free bytes via Node `fs.promises.statfs` on the **actual protected state parent path** `C:\ProgramData` and the **owner's actual profile path** returned by `os.homedir()`. This also handles mount points and different source/destination volumes, which probing the drive root `C:\` alone cannot establish. The checks are read-only, use `BigInt` for byte arithmetic, and fail closed on invalid/inaccessible filesystem metadata in either location.
- Operational floor: **4.1 GiB**. A lower value throws `AI04_CUTOVER_DISK_RESERVE_INSUFFICIENT`. Failed or malformed filesystem probes throw `AI04_CUTOVER_DISK_RESERVE_UNVERIFIED`.
- Recommended headroom remains **8 GiB on both paths**, reported separately from the hard 4.1 GiB floor and *not* confused with physical cutover acceptance. A low source-volume reserve is not ignored when the protected destination has ample space.
- `scripts/ai04-controlled-system-hub-cutover.ts` checks disk **before recovery artifacts are created** and again after recovery task verification **before the old user Hub is disabled**. The second check catches space consumed between these stages.
- These checks do not replace sufficient space during the offline SQLite/credential state copy; hardware, protected ACLs, actual SYSTEM DPAPI, rollback, reboot and second-device acceptance remain independently required.

## Test evidence on Windows Work-PC

- Storage test, controlled cutover, rollback and recovery: 22/22 PASS.
- Delegated integration source suite: 407 PASS, 0 FAIL, 2 SKIP.
- AI-07 physical gates, AI-04 source contracts and preservation: 36/36 PASS.
- TypeScript typecheck and build: PASS.
- Source only; hosted exact-head GitHub CI must be checked on the resulting commit separately.

## Follow-up: source and destination volume coverage

The later dual-path change (based on #1160 source `489df3062cb48eb1f5b33109cb0a6a8ecb2d79c2`) keeps both lifecycle checks in place and additionally probes `C:\ProgramData` and `os.homedir()` at each checkpoint. Simulated D: profile low-space and ProgramData mount-point cases fail closed; the boundary tests use one-byte blocks so a one-byte deficit cannot be rounded up to PASS. Updated controlled-cutover and recovery target suite: **24 PASS / 0 FAIL / 0 SKIP** on Work-PC, TypeScript check PASS. These are source-only tests, not proof of physical SYSTEM migration.


## Follow-up: authoritative legacy source-state volume

A later source-only correction (parent commit \`1eea991ba3654482a9847cd743cb0771aa782d58\`) uses the validated \`NEXOWIRE_STATE_DIR\` from the persisted user Hub launcher, not just \`os.homedir()\`. This is necessary when the owner or elevated administrator profile is on a different volume from the legacy Hub state, including nested volume mount points. The cutover checks protected \`C:\ProgramData\`, current profile, and the canonical legacy source path before arming recovery and checks all three again immediately before stopping the user Hub. If any statfs probe fails or a volume has less than 4.1 GiB free, the cutover refuses. All three must meet the recommended 8 GiB for advisory green status. Distinct source volume regression: synthetic \`E:\StateMount\Nexowire\hub\` at 1 GiB is denied even when the other two locations have 8 GiB; an unreadable source mount is also denied. The change is a read-only source gate, not physical SYSTEM, DPAPI or rollback acceptance.

No physical SYSTEM transition has been executed; `trustedSystemHubAcceptance=NOT_RUN` and `fullCoreAccessVerified=false` remain the operational truth.
