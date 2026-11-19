# v1.0.9 AI-04 controlled cutover disk recheck — 2026-11-19

## Source scope

Parent #1160 exact HEAD: `fbcc9b4326044617eb21efd405da027f076dcca2`. This is a source change to **future, explicitly approved** controlled SYSTEM Hub migration. It does not initiate a live migration, stop the interactive Hub, modify Scheduled Tasks, change Broker authority, or touch DPAPI/SQLite protected state on Work-PC.

## Read-only gate

- `src/hub/system-cutover-disk-reserve.ts`: measures free bytes on the protected state destination volume `C:\` via Node `fs.promises.statfs`. The check is read-only, uses `BigInt` for byte arithmetic, and fails closed on invalid/inaccessible filesystem metadata.
- Operational floor: **4.1 GiB**. A lower value throws `AI04_CUTOVER_DISK_RESERVE_INSUFFICIENT`. Failed or malformed filesystem probes throw `AI04_CUTOVER_DISK_RESERVE_UNVERIFIED`.
- Recommended headroom remains **8 GiB**, reported separately and *not* confused with physical cutover acceptance.
- `scripts/ai04-controlled-system-hub-cutover.ts` checks disk **before recovery artifacts are created** and again after recovery task verification **before the old user Hub is disabled**. The second check catches space consumed between these stages.
- These checks do not replace sufficient space during the offline SQLite/credential state copy; hardware, protected ACLs, actual SYSTEM DPAPI, rollback, reboot and second-device acceptance remain independently required.

## Test evidence on Windows Work-PC

- Storage test, controlled cutover, rollback and recovery: 22/22 PASS.
- Delegated integration source suite: 407 PASS, 0 FAIL, 2 SKIP.
- AI-07 physical gates, AI-04 source contracts and preservation: 36/36 PASS.
- TypeScript typecheck and build: PASS.
- Source only; hosted exact-head GitHub CI must be checked on the resulting commit separately.

No physical SYSTEM transition has been executed; `trustedSystemHubAcceptance=NOT_RUN` and `fullCoreAccessVerified=false` remain the operational truth.
