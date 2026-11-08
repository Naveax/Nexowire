# P006 K20 — exact-HEAD CI / issue lifecycle / task-credit audit

Date: 2026-11-08 (Europe/Istanbul). Scope: issues [#1006](https://github.com/Naveax/Nexowire/issues/1006), [#539](https://github.com/Naveax/Nexowire/issues/539), [#487](https://github.com/Naveax/Nexowire/issues/487). Upstream source `main@52d452f717d891eeaf4c2b9aff3c6e1ea68369b0` (merge #1135). Read-only QA; no workflow, auth, CORE, Broker, SQLite, WAL or installed device edits.

## T-649 — real CI RED: owner workflow fixed test-total gate

The **unchanged**, owner-controlled `.github/workflows/ci.yml:67–68` runs K20 `.test.mjs` with pool-K07 and then requires exact strings `# tests 41` and `# pass 41`. Observed exact-PR-head hosted job logs:

| PR (Draft) | Exact head SHA | CI run / failed job | Real TAP | Conclusion |
|---|---|---|---|---|
| [#1118](https://github.com/Naveax/Nexowire/pull/1118) | `d51d9d4c2c25797405227bad223039c6b31055d2` | [42411030903](https://github.com/Naveax/Nexowire/actions/runs/42411030903) / 128519002548 (Node 22) | 50 tests, 50 pass, 0 fail | **FAIL** fixed-41 gate |
| [#1130](https://github.com/Naveax/Nexowire/pull/1130) | `8a5bc56ebe1004595e4cebbd5bc363fe51892534` | [42412252743](https://github.com/Naveax/Nexowire/actions/runs/42412252743) / 128522716363 (Node 24) | 48 tests, 48 pass, 0 fail | **FAIL** fixed-41 gate |
| [#1141](https://github.com/Naveax/Nexowire/pull/1141) | `a13dd68d0585d5f4b2617beb121702a2db7850ea` | [42474379692](https://github.com/Naveax/Nexowire/actions/runs/42474379692) / 128712299256 (Node 22) | 52 tests, 52 pass, 0 fail | **FAIL** fixed-41 gate |

The final #1141 log shows `1..52`, `# tests 52`, `# pass 52`, `# fail 0`, `# skipped 0`, `# todo 0`, then `Process completed with exit code 1` in the K20 gate. Previously this was `QUEUED`; **now completed FAILURE**. An isolated 41/41 fixture matches the old gate; expanded passing TAP counts 48/50/52 do not. The requested source fix belongs to **Ömer's active Draft [#1096](https://github.com/Naveax/Nexowire/pull/1096)** (current head `e879ecb8e70a0e798c73c6028400b11e3e8bb4e7`); K20 did not modify or rerun CI. A dynamic positive-count/zero-fail/zero-skip/zero-todo gate is the owner-review *proposal*, not a source patch. Exact-HEAD CI cannot be reported PASS for any of these PRs.

## T-650 — credits: P006 source assignments vs P005 reported completion

`ekip/PANO.md` blob `ee3b9f65df141ce5d2b8933ab82956597aca30e7`: 20 KNN sections × 6 P006 tasks = **120 unique IDs T-535…T-654**, no missing or duplicate ID. K03's new T-547…T-552 are **backup**, not active ahead of its older P005 T-407…T-412. P005 **92/120 delivered locally/source; 28 partial/unverified** is a **board-reported** figure, not 92 verified merges or issue resolutions. All 20 individual status-file claim texts were separately read; they contain one cross-worker pool claim **T-385 (K02, K16)**. Tie-break owner **K02**; K16's repeated claim receives **no additional task credit**. A repeated claim is *not* credited twice. The `claimsByWorker` snapshot excludes textual historical task mentions without `ÜSTLENDİM:`; independent verification of all 92 delivered artifacts remains **NOT_VERIFIED**.

## T-651 — #487 auto-close/reopen is not release acceptance

[#1135](https://github.com/Naveax/Nexowire/pull/1135) is truly merged in main (`52d452f…`). PANO P006 records GitHub auto-closing issue #487 after a negated sentence containing closing keyword + issue number; ŞEF then reopened it. Independent current issue API confirms **#487 OPEN** (as of inspection); individual closed/reopened timeline events were **not independently fetched**. A new offline negative regression detects `cannot close #487` in a PR body, but neutral `Acceptance for issue #487 remains OPEN` does not trigger it. Neither a merged source patch nor a transient `CLOSED` issue state proves S5 hosted provider billing/soak or physical-device acceptance. **NOT_RUN**.

## T-652 — complete 44-PR source enumerator, independent of K14

The GitHub PR API was queried **individually for every integer PR #1099…#1142** (44 entries; exact HEAD recorded in [`P006_EVIDENCE_SNAPSHOT_20261108.json`](./P006_EVIDENCE_SNAPSHOT_20261108.json)): **42 open Draft, exactly 2 merged (#1102 and #1135)**, zero missing PRs/duplicate numbers in this fixed interval. This independently matches the P006/K14 board claim. It is a **bounded historical PR range**, *not* a proof that no earlier/later Draft exists anywhere in the repository. Fresh issue-list pagination and mergedness are separate; no issue auto-closed based on this count.

## T-653/T-654 — false-PASS CLI regression and immutable gates

- `p006-ci-issue-gate.mjs --input test/delegated/k20/fixtures/p006-seven-green-no-discovery.json`: controlled case reports **7/7 successful jobs, zero nested execution proof, discovery NOT_VERIFIED, accepted=false**, and process **exit code 1 (expected RED)**. This fixture is not a real hosted run.
- Positive reviewable log requires the exact requested new test **path** and a test assertion **marker** in the **same exact-head run's log**, not a generic `7/7 success` job summary. Such logs remain unauthenticated input until independently checked on GitHub.
- Old run SHA and changed PR SHA => `STALE_OR_UNKNOWN_HEAD`; empty/truncated jobs => `JOBS_MISSING`; failing job => `CI_NOT_GREEN`.
- No physical Windows machine exercised. Even a supplied `physical-windows` claim requires an installed-build SHA match and evidence identifier, then remains **REPORTED_NEEDS_REVIEW**, never accepted by this offline tool. A new PR still needs its own exact-HEAD hosted run and source-owner decision.

## Reproduction commands and boundaries

```bash
node --test test/delegated/k20/p006-acceptance.test.mjs
node --test --test-reporter=tap --test-concurrency=1 test/delegated/k20/*.test.mjs test/delegated/pool-k07/safe-url-language.test.mjs
node scripts/delegated/k20/p006-ci-issue-gate.mjs --input test/delegated/k20/fixtures/p006-seven-green-no-discovery.json
```

The third command is **expected exit 1**, not a failed real CI run. Snapshot is source-derived and time-bounded, not an authenticated live provider or device acceptance. No PR/issue closure, source owner workflow fix, network dispatch, or physical test is claimed.
