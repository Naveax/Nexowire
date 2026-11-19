# P005 K05 / #539 and #485: CI discovery, negative UI behavior, owner handoff

Date: 2026-11-08 (Europe/Istanbul). Tasks T-419…T-424. K05 source-only QA, **not** a fix to protected or owner-owned source.

| Pinned source | SHA | Status / use |
|---|---|---|
| `Naveax/Nexowire@main` | `b5a3f8840517d65ecbd6a018699c4c8bdde09987` | Current baseline, 2026-11-08 `git ls-remote` verified. |
| [Owner web Draft #1068](https://github.com/Naveax/Nexowire/pull/1068) | `94d38799e9e4b50fe84f7924e6fc84f90aeba090` | Separate read-only candidate checkout, **not merged**. |
| [K05 Draft #1115](https://github.com/Naveax/Nexowire/pull/1115) | `2a74d9d2c0c42265c4ee27494eb530059904c0b3` | New test `audit-owner-web.test.mjs`, separate PR. |
| [K05 Draft #1122](https://github.com/Naveax/Nexowire/pull/1122) | `aaa96bde77bd6c4a03bc6b653be268727ee44f18` | New test `verify-ui-test-provenance.test.mjs`, separate PR. P004 T-382 ownership credit belongs to lower-number K04 per P005. |

## T-419 — green runs, uninvoked K05 tests

GitHub Actions exact-HEAD run [#42410556545](https://github.com/Naveax/Nexowire/actions/runs/42410556545) (#1115) and [#42411789831](https://github.com/Naveax/Nexowire/actions/runs/42411789831) (#1122) both show **completed/success, 7/7 jobs success** (observed 2026-11-08). The real `test (22)` and `test (24)` job steps include *Verify delegated batch-3 offline accessibility and MCP error QA* but that script calls the **older** `audit-html.test.mjs`, `dynamic-id-contract.test.mjs`, and `pool-k05/touch-evidence.test.mjs`. It does **not** call either newly added K05 test file. `package.json` `npm test` glob is `test/**/*.test.ts`, which does not discover `.test.mjs`.

Consequently, both runs are green for their **invoked jobs**, not hosted PASS for the new K05 tests. The new tests' specific CI discovery is **NOT_RUN**. The K05 scanner compares actual `run:` command bodies and npm test script; a fixture mentioning a test only in a comment is rejected. Source changes to `.github/workflows/ci.yml` belong to owner #1096, delegated discovery workflow belongs to **K13**. K05 makes **no workflow change**.

## T-420 — HTTP 401/403 wrong “Offline” diagnosis

Real source reproduction uses `node:vm` with a fake DOM and fake `/api/v1/admin/overview` fetch response, **no live credentials/network**:

- On `main`, `web/admin.js:38` sets `#admin-pill` to `Offline` on either HTTP 401 or 403. The error content reads HTTP 401/403 and panel becomes visible, but `web/admin.html:32` still lacks `role="alert"`, and loading-busy readback is not present.
- On owner [#1068](https://github.com/Naveax/Nexowire/pull/1068) source candidate, `web/admin.html:62` has `role="alert"` and `web/admin.js` clears busy state, **yet HTTP 401/403 still labels the pill `Offline`** (`admin.js:69`). Permission/auth denial and network offline are different reasons. No valid success was observed, but the diagnosis is misleading.
- The negative classifier rejects a false `Başarılı`/`good` pill, a hidden/empty error alert and a loading state left busy. K04 owner should distinguish a real authorization failure from a failed transport in their source, without changing auth policy. Existing K04 [#1104](https://github.com/Naveax/Nexowire/pull/1104) is noted by P005 as a RED owner integration case.

## T-421 — connect invalid callback, cancel and focus

Source audit checks three independent paths: invalid/missing callback fallback to install panel, error/retry focus transfer, and cancel link back to `/`. Main has install fallback and cancel link but neither source error/retry focus marker; #1068 candidate adds `error-panel.focus()` and `approve.focus()`, though **invalid callback fallback still has no explicit focus transfer**. Synthetic negative mutation detects missing fallback/cancel and absent focus. These are source observations; actual keyboard focus loss and screen-reader announcements **NOT_RUN**.

## T-422 — duplicate device names

Main `web/app.js` has visible `device.name` but no ordinal `deviceLabel` source contract. #1068 candidate `web/app.js:469` adds ordinal context (`device.name` + device index), with scoped accessible action names for CORE, Bridge, folder and PC settings. K05 negative fixture rejects a shared ordinal or missing device context. Actual two identical-name devices and wrong-device dispatch are **NOT_RUN**; K03/K15 hold UI integration/physical confirmation.

## T-423 — refuse unsupported accessibility acceptance

`evaluateEvidence` rejects `scope: SOURCE_ONLY` reported as `nvda: PASS`, `chromium: PASS`, `device: PASS`, uninvoked K05 tests reported as CI PASS, or any unsuccessful run claimed as CI PASS. Even with both global CI runs green, none of this establishes a Windows screen-reader or #485 signed installer acceptance.

## T-424 — three owner-directed source handoffs

| Priority | Owner, source and exact context | Repro / ask |
|---|---|---|
| 1 | **K04**, `web/admin.js` / `web/admin.html`: `main@b5a3f88…` + owner #1068 `94d3879…`. | **401/403 → Offline** reproducible in both. Distinguish access denial from offline; include `role=alert` from candidate and verify actual screen-reader text. No changes to auth policy. |
| 2 | **K01**, `web/connect.html:52` and `web/connect.js`: same two SHAs. | `#copy-status role=status` is nested in `#install-content aria-live=polite`; double-announcement risk persists in #1068. Invalid callback branch still has no explicit focus transfer; keyboard/AT reality NOT_RUN. |
| 3 | **K03**, `web/app.js`: `main@b5a3f88…` vs #1068 `94d3879…`. | Duplicate-name ordinal/source actions improved in candidate, but not main; verify two same-name devices and accessible controls on real UI. K15 owns separate device QA. |

Separately for **K13/ŞEF**, attach both exact CI run links and their uninvoked K05 new test paths; verify discovery in a future run from the same exact SHA before upgrading K05 CI status. There is no path collision because K05 changed only `scripts/delegated/k05/**`, `test/delegated/k05/**`, `docs/delegated/qa-accessibility-k05/**`. Protected owner [#1096](https://github.com/Naveax/Nexowire/pull/1096) and web owner #1068 files were read-only.

## Commands and results

```sh
node --test test/delegated/k05/audit-p005-evidence.test.mjs
node scripts/delegated/k05/audit-p005-evidence.mjs .
node scripts/delegated/k05/audit-p005-evidence.mjs /path/to/owner-1068-checkout
```

Unit tests: **8/8 PASS**, including negative assertions. Source scanner: deliberately **exit 1** with detected failures, both on named main and #1068, so it is **not a clean audit PASS**. Scanners run fake fetch responses in isolated `vm`; browser, Chromium, NVDA, actual Windows/installer, 320/375px/zoom, real user/device are **NOT_RUN**. Nothing here closes #539 or #485, merges #1068, or supersedes K04's T-382 claim.
