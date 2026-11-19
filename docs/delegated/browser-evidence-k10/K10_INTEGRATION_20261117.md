# K10 offline three-state visual evidence CI integration — 2026-11-17

## Source and scope

- Exact source Draft PR #1142 head: `c7b24e90434e744b8ada4bae89620da36dcede56`.
- Exact review base: Draft PR #1160 at `3834ebc7e6d3aabee6be0d9d0dd840f6c1762d31`.
- Imported five source paths without overwriting existing `test/delegated/k10/offline-web-smoke.test.mjs`: two source-audit scripts, two test suites and one **dated historical** CI-gap report.
- Preserved network isolation: offline visual fixtures permit only intended same-root static resources; actual pairing, authorization, device connectivity, and independent 3-state browser screenshots remain **NOT_RUN / NOT_VERIFIED**.
- Repaired Windows test fixture: filesystem escape negative uses a real external-directory junction on Windows (without file-symlink privilege), with the original file symlink on other platforms. The request is still rejected.

## CI / source verification

- Two K10 suites: **25/25 PASS** on Windows, zero skips.
- Explicit delegated source-transfer suite includes both new K10 suites; expected total assertions: **404** (previously 379). Windows local: **402 PASS / 0 FAIL / 2 SKIP**; two unrelated file-symlink permission tests remain skipped on Windows and must be run in Linux CI.
- TypeScript typecheck and build PASS.
- Updated candidate blob pointers in the 79-row, 243-row, and 290-row source-preservation CSV ledgers. Historical original source blob fields are preserved.
- Hosted exact-head CI is required before merging into the integration branch; no CI rerun should be triggered for the same SHA and input.

## Acceptance boundary

These tests are **synthetic HTML/CSS/layout and offline CI evidence QA**, not evidence of authenticated ChatGPT device pairing, completed keyboard-only navigation, actual screenshots captured in a hosted runner, or physical two-PC Windows acceptance. They do not modify runtime agent, running services, or SQLite.
