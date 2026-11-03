# CLEAN-02 | Evidence-locked COVERED_BY_NEWER (2026-11-03)

**Eight exact changed-file blob-identity findings. ZERO closure-approved SUPERSEDED PRs.**

Targets: #1067 @ `84ac01c2ac50d1817ec26725d5fa3d8867af87da` (CORE coordinator, DRAFT/production NO-GO); #811 @ `daa166e42f94fa1529b48c293a51c58b1c2384e7` (Git sandbox security source, DRAFT/Windows CI RED).

| Old PR | Exact HEAD | Target exact HEAD | Same-path blob match | Exact HEAD CI (check-runs) | Direct children / total descendants | Closure |
|---|---|---|---:|---|---|---|
| [#607](https://github.com/Naveax/Nexowire/pull/607) | `0c60d5ef01144e38cdf31afdf65044cb7ebff093` | [#1067](https://github.com/Naveax/Nexowire/pull/1067) `84ac01c2ac50d1817ec26725d5fa3d8867af87da` | 4/4 | 7/7 success | 614 / 40 | **HOLD** |
| [#631](https://github.com/Naveax/Nexowire/pull/631) | `4e0cb8f5a00deb7ca00352ff24350402936ba59c` | [#1067](https://github.com/Naveax/Nexowire/pull/1067) `84ac01c2ac50d1817ec26725d5fa3d8867af87da` | 6/6 | 7/7 success | 637, 676 / 38 | **HOLD** |
| [#676](https://github.com/Naveax/Nexowire/pull/676) | `b935a594a68c2ba3e043b0731e5eb6d01081fa07` | [#1067](https://github.com/Naveax/Nexowire/pull/1067) `84ac01c2ac50d1817ec26725d5fa3d8867af87da` | 6/6 | 7/7 success | 680, 702 / 35 | **HOLD** |
| [#859](https://github.com/Naveax/Nexowire/pull/859) | `68ee74ce7e1e5a36c8ae2f9b065f49a5cb13cee9` | [#1067](https://github.com/Naveax/Nexowire/pull/1067) `84ac01c2ac50d1817ec26725d5fa3d8867af87da` | 10/10 | 7/7 success | 990 / 2 | **HOLD** |
| [#786](https://github.com/Naveax/Nexowire/pull/786) | `8d5390dc8ed94e13ac380c6e37aa6f4de2888d4b` | [#811](https://github.com/Naveax/Nexowire/pull/811) `daa166e42f94fa1529b48c293a51c58b1c2384e7` | 1/1 | 5/7 success, 1 failure, 1 cancelled | none / 0 | **HOLD** |
| [#800](https://github.com/Naveax/Nexowire/pull/800) | `6eb562cffd68a5d123e8ec2455fd2d3d8d9a9fd8` | [#811](https://github.com/Naveax/Nexowire/pull/811) `daa166e42f94fa1529b48c293a51c58b1c2384e7` | 1/1 | 5/7 success, 1 failure, 1 cancelled | none / 0 | **HOLD** |
| [#821](https://github.com/Naveax/Nexowire/pull/821) | `ef87410cc7921540dabf33b83e42824cce4f4668` | [#811](https://github.com/Naveax/Nexowire/pull/811) `daa166e42f94fa1529b48c293a51c58b1c2384e7` | 1/1 | 5/7 success, 1 failure, 1 cancelled | none / 0 | **HOLD** |
| [#839](https://github.com/Naveax/Nexowire/pull/839) | `4eab61585f3f4174f4477a5ee671a0cee2a46398` | [#811](https://github.com/Naveax/Nexowire/pull/811) `daa166e42f94fa1529b48c293a51c58b1c2384e7` | 1/1 | 5/7 success, 1 failure, 1 cancelled | none / 0 | **HOLD** |

## Exact Git blob proof by path

### PR #607 → #1067

- `docs/AGENT_JOURNAL_P0_EXTERNAL_CAS_20261020.md` (modified): `043621f854fce64d65118ad6fb9672be0ba54e38` == target tree same-path blob SHA
- `src/agent/remote-mutation-cas.ts` (modified): `aaf39646fd125962c1ef4928643e362f32ad934f` == target tree same-path blob SHA
- `test/agent-remote-cas.test.ts` (modified): `d904d1684c8b4048d76387d3b1b4107fef0b0300` == target tree same-path blob SHA
- `test/fixtures/agent-remote-cas-fixture.ts` (modified): `6d3e6e680543818d5c859409db291364be3ae1eb` == target tree same-path blob SHA

### PR #631 → #1067

- `docs/AGENT_JOURNAL_P0_WITNESS_DELEGATION_EPOCH_20261021.md` (added): `8657595302a70b8133660fab365b57dbec0ec2e7` == target tree same-path blob SHA
- `sql/agent-witness-delegation.sql` (added): `e738540d08597fb97025800b345cdbdcef2fdc1f` == target tree same-path blob SHA
- `src/agent/postgres-monotonic-witness.ts` (modified): `914c9f8584b668b88044bf6108f46bbf8dc36834` == target tree same-path blob SHA
- `src/agent/witness-delegation.ts` (added): `faec6c99d67acf1c28d3b1c71409c84651bccad5` == target tree same-path blob SHA
- `src/agent/witness-signed-provenance.ts` (modified): `cbfbbe7d4769f67ee5f187c4a61316af442d1d3c` == target tree same-path blob SHA
- `test/witness-delegation.test.ts` (added): `ccf5671b9de0404c23c014018368980442850f31` == target tree same-path blob SHA

### PR #676 → #1067

- `docs/AGENT_P0_EXTERNAL_GRANT_ATOMIC_RECONCILIATION_20261021.md` (added): `e1893f3b2becf48d0cdf676c0c02d1e60d1de0af` == target tree same-path blob SHA
- `src/agent/https-external-grant-cas.ts` (added): `d81f4a7a06141bffef9431f9217f6d022dc92493` == target tree same-path blob SHA
- `src/agent/postgres-bound-grant-cas.ts` (added): `954354f7ef7e35ab87a48592df2d40430c8d809f` == target tree same-path blob SHA
- `src/agent/witness-revoke-coordinator.ts` (added): `f2e1999a8e1a6978be314f1c10760acf7332a52d` == target tree same-path blob SHA
- `test/https-external-grant-cas.integration.test.ts` (added): `aee03d095c29c0a79ac51eb1411ad2eb65187d15` == target tree same-path blob SHA
- `test/postgres-bound-grant-cas.integration.test.ts` (added): `b8287df4c225ded8d16f16be3402dd72b1713ec7` == target tree same-path blob SHA

### PR #859 → #1067

- `docs/P1_780_07_RUNTIME_HANDOFF_20261027.md` (added): `81d902f9b599dc8e06cbe5df37777e20137560a6` == target tree same-path blob SHA
- `docs/P1_780_07_TASK_OS_SANDBOX_PROVIDER_CONTRACT_20261024.md` (added): `a1589b22a12373b2b8757d1943dfd27c54b95813` == target tree same-path blob SHA
- `native/task-os-sandbox-linux-namespace-probe-p07.c` (added): `5baf71374b7189d695677d47eef23a316e33e143` == target tree same-path blob SHA
- `src/agent/task-os-sandbox-capability.ts` (added): `f5d5141f510ec537a194024bb935655b760f2439` == target tree same-path blob SHA
- `src/agent/task-os-sandbox-policy.ts` (added): `a35e1b25d40b2a0d796dd9fdd51d7079370e6730` == target tree same-path blob SHA
- `src/agent/task-os-sandbox-worker.ts` (added): `08c43def4ac12cff1cb532c4960ed5c5ddf0dba8` == target tree same-path blob SHA
- `test/task-os-sandbox-capability-p07.test.ts` (added): `243bcbefa338827c82ab4208b301ff7f51fcbe7e` == target tree same-path blob SHA
- `test/task-os-sandbox-linux-native-p07.test.ts` (added): `bb230e40a575611ed0e226857761eac973e962e9` == target tree same-path blob SHA
- `test/task-os-sandbox-policy-p07.test.ts` (added): `387ce6e5351678d5c19afb5f293d2083d8d54829` == target tree same-path blob SHA
- `test/task-os-sandbox-worker-p07.test.ts` (added): `b8417ab6869a0bb2b2abde83ffd5f247bbc78622` == target tree same-path blob SHA

### PR #786 → #811

- `test/p26-780-git-worktree-root-escape-negative.test.ts` (added): `866c12289db344ef72d6c3a63112228c970aa0b9` == target tree same-path blob SHA

### PR #800 → #811

- `test/p20-780-git-fsmonitor-hook-escape-negative.test.ts` (added): `50a9b1437d66347c83e87164bc9d7233f1ae4a98` == target tree same-path blob SHA

### PR #821 → #811

- `test/p50-780-git-clean-filter-external-command-negative.test.ts` (added): `42b2d233acc4ee93f93993b4ba7bb1da6774d50b` == target tree same-path blob SHA

### PR #839 → #811

- `test/p50-780-git-process-filter-external-command-negative.test.ts` (added): `fabef7b6d77a9f2ab6b54ae86ba0df57cb2e5ff5` == target tree same-path blob SHA

## Safe closure preconditions

1. Keep originals OPEN until target branch is accepted and merged by its owner with all required security/CI gates. DRAFT and/or source 7/7 CI is not production acceptance.
2. Resolve each open child's actual base SHA and compare against the future landing commit. Retarget or recreate only in its owner's permitted scope; retain every unique negative test, especially UNKNOWN/revoke/rollback/Git filters.
3. Recompute complete changed-file blob identity on **the then-current main**, run `git merge-base`, `git cherry`, `git patch-id --stable` for true patch equivalence, and ensure no outstanding review/comments unique to the old PR.
4. Obtain exact-head CI and all required tests on the actual integrated commit. Only then annotate each old PR with new landing commit and close ONE at a time by coordinator review. No bulk closure.

**Important limitation:** matching final Git blobs does not prove patch-id equality or identical commit ancestry. Local git remote fetch was DNS-blocked; patch IDs remain `NOT_COMPUTED`. CI conclusions above are from commit SHA's reported check-runs and are not statements about deployed machines, physical containment or durable external trust.

**Do not merge, close or delete any of these PRs on this report alone.**
