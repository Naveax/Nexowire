# T-382 / #539 — one-main-source UI test provenance

Date: 2026-11-07; owner K05. This is an offline QA guard for repeated source-level UI suites, **not** an assertion that Reliability Doctor R11 or a real client was accepted.

## The failure mode

A report can accidentally combine passing UI test counts from one checkout with a different source candidate (for example upstream `main` versus owner Draft [#1068](https://github.com/Naveax/Nexowire/pull/1068)), then call the combined number “current main PASS.” That is invalid even when each test ran successfully in isolation.

`scripts/delegated/k05/verify-ui-test-provenance.mjs` runs two checked-in K05 HTML/ID suites in one process, bound to one checkout. It rejects:

- an invalid or stale claimed `main` SHA compared with the local `upstream/main` ref;
- a checkout whose committed `web` tree differs from the claimed main commit;
- dirty/untracked `web/**` paths before or after test execution;
- a change in the entire tracked `web/**` SHA-256 byte digest during test execution;
- a nonzero/timed-out test process, missing TAP counts, failed tests or zero test cases.

Test processes are launched with argument arrays (no shell evaluation). The script uses no network, secrets, live Hub/Agent or production service. It exits 1 on any failure and returns explicit `SOURCE_ONLY`, `browser: NOT_RUN`, `screenReader: NOT_RUN`, `physical: NOT_RUN` markers when provenance holds.

## Reproduction on the named baseline

Upstream main was checked read-only with `git ls-remote upstream refs/heads/main` and returned `4e7db16f4233048a956664bef6b607781eb63fb7` (2026-11-07). In a clean code worktree freshly created from that commit:

```sh
node --test test/delegated/k05/verify-ui-test-provenance.test.mjs
node scripts/delegated/k05/verify-ui-test-provenance.mjs --main 4e7db16f4233048a956664bef6b607781eb63fb7
```

Observed: 6/6 negative and positive provenance tests PASS; one process ran the existing UI suites at 24/24 PASS. `HEAD:web` and `main:web` were both Git tree `fcd15697e51f0df9447cacfd826b549a25014ce9`; tracked web SHA-256 before/after both `9a0c090763f04bf7fc41b6958b829b3786ccb174515448f71316ebbd3509661f`. The non-mutating runner returned `verified: true`, **only for source provenance**.

## Negative fixtures and limits

Automated tests simulate stale main commit, mixed owner PR web tree, dirty web files before/after, mutated source bytes during tests, and combined failures: each is rejected. These are isolated control tests, not a simulated browser run.

Important: `upstream/main` is a **local remote-tracking ref**. This tool does not fetch or attest a live remote branch. Verify `git ls-remote upstream refs/heads/main` separately immediately before the run; otherwise the “main” identity may be stale. A clean matching web tree cannot validate application runtime behavior, accessible-name computation in the DOM, actual keyboard navigation, NVDA, real devices, UI rendering, or the full #539 acceptance gate. Those remain `NOT_RUN`.

Owner paths `web/**`, [#1068](https://github.com/Naveax/Nexowire/pull/1068) and [#1096](https://github.com/Naveax/Nexowire/pull/1096) were not changed. All additions are in K05's independently permitted `scripts/delegated/k05/**`, `test/delegated/k05/**`, and `docs/delegated/qa-accessibility-k05/**`.
