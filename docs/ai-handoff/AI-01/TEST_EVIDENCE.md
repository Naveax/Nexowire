# AI-01 | TEST_EVIDENCE

## Exact source and CI snapshot

| Item | Evidence |
| --- | --- |
| Draft PR / branch | [#986](https://github.com/Naveax/Nexowire/pull/986), `ai/01-wal-v108` |
| Base main | `a19a228dc6f19fd484cf935e941a00ea625233f8` |
| Current source/test HEAD | `236d256224724e1df1b4da1431b60c4a27b896ea` |
| Exact-source workflow | [#41247613793](https://github.com/Naveax/Nexowire/actions/runs/41247613793); **COMPLETED SUCCESS, 7/7 jobs** on exact source SHA. |
| Node 24 | job `124674231463`: **SUCCESS**, 2,341 tests / 2,049 PASS / 0 FAIL / 292 SKIP / 0 TODO |
| Node 22 | job `124674231474`: **SUCCESS**, new negatives `ok 132` and `ok 133`; check/build passed |
| macOS / Linux native / WSL2 / security-operational | jobs `124674231323`, `124674231542`, `124674231586`, `124674231502`: **SUCCESS** |
| Windows runner | job `124674231529`: `npm run typecheck` and dedicated recycled WAL/restart regression **SUCCESS**; DPAPI/pre-logon Hub and CORE-console contract steps also **SUCCESS** |

These records come from GitHub-hosted jobs for the **exact SHA** above. They are not a claim of local `npm ci`, a physical Agent run, or a real-device acceptance. A future docs-only head needs its **own** CI.

## Exact CI test commands and exit status

- **Ubuntu Node 22 and Node 24 GitHub-hosted runners:** `npm ci` → `npm run check` → `npm run build`; each workflow step `success` (**exit 0**). The `check` script runs `npm run typecheck`, continuation/launch audits and `npm test`, which is `node --test --import tsx test/**/*.test.ts`. This test glob includes the 18 AI-01 tests.
- **Windows GitHub-hosted runner:** `npm run typecheck` and `node --test --import tsx --test-concurrency=1 test/qa-journal-wal-recycle-p11.test.ts test/agent-operation-wal-integrity.test.ts test/agent-journal-restart-regression.test.ts test/native-agent-startup-diagnostic.test.ts`, both `success` (**exit 0**). GitHub Windows DPAPI/pre-logon contract and CORE-console contract steps also `success`, but are **not** owner-enrolled physical device evidence.
- These are **CI runner exit outcomes**, not commands claimed to have been executed from this chat machine.

## Positive + negative matrix

- **18 new disposable AI-01 test cases** in `test/ai01-wal-snapshot-races.test.ts`, plus existing unchanged `test/qa-journal-wal-recycle-p11.test.ts` and coordinator-owned journal test suites.
- Positive: authentic hot and RESTART/recycled SQLite WAL with retained prior-generation allocation, stable zero-length WAL, WAL-only `UNKNOWN` on independent SQLite reopen and non-replay, both WAL and SHM sidecars absent for a fresh clean journal.
- Negative: current salt/checksum/corrupt header, partial and truncated physical WAL frames, checksum-valid uncommitted final frame, SHM/WAL header and pathname/inode/metadata races, pre-open truncate, observed-then-vanished WAL or SHM, and a missing WAL with **orphaned SHM**.
- Two newest tests: `orphaned SHM after WAL loss denies silent UNKNOWN replay-data loss` and `clean absence of both WAL and SHM permits a new journal`; actual Node 24 **PASS** and Node 22 `ok 132`/`ok 133`. No weakened assertions or newly introduced skips.
- Previously existing isolated #974 regression: 709 current and 295 retained old physical WAL frames, 473 committed frames and 1,307 synthetic records; six simulated crashes/restarts plus one clean restart, `UNKNOWN` terminal records and duplicate UUID denial. This shared test's source was not modified.
- POSIX open-file rename test skips on Windows are explicit OS-dependent cases; GitHub Windows contract tests do **not** prove these physical Windows namespace races.
- Source preflight never deletes/checkpoints/copies over a user's WAL, database, token or credentials.
- Independent disposable SQLite (Node 22.16.0 / SQLite 3.49.1) reproduction showed: `old=committed` in checkpointed base and `new-unknown=unknown` only in WAL; removing `-wal` with `-shm` left behind caused an ordinary SQLite reopen to display only `old`. This is **not** evidence of a real user's database failure.

## Historical exact SHA / run attribution

- `f33bc494fe4efe2a75d5a4a91917661afba8fa4b`, [#41197139627](https://github.com/Naveax/Nexowire/actions/runs/41197139627): first Windows attempt had 30s child IPC timeout with empty stderr in coordinator-owned journal restart test; only failed job rerun, final CI 7/7 SUCCESS. Exact worker hang cause not proven; no test timeout changed.
- `0f6e35e5abbd0bfee006e0757f7477c2f69b2834`, [#41199721229](https://github.com/Naveax/Nexowire/actions/runs/41199721229): 7/7 SUCCESS.
- `9b6464f034d67d3ade059585fe8739932733f319`, [#41211304023](https://github.com/Naveax/Nexowire/actions/runs/41211304023): 7/7 SUCCESS; Node24 2,337 / 2,045 PASS / 0 FAIL / 292 SKIP.
- `eaff829784f10306066cc4714a2eaa3b7cc79282`, [#41243619101](https://github.com/Naveax/Nexowire/actions/runs/41243619101): 7/7 SUCCESS; Node24 2,339 / 2,047 PASS / 0 FAIL / 292 SKIP.
- `7875ba77fe0f33be393cbf3c49d16ae9e839b5ff`, [#41246634670](https://github.com/Naveax/Nexowire/actions/runs/41246634670): **CANCELLED** after newer source push; 6 completed jobs SUCCESS at last checkpoint do not equal total workflow PASS.
- `236d256224724e1df1b4da1431b60c4a27b896ea`, [#41247613793](https://github.com/Naveax/Nexowire/actions/runs/41247613793): latest source, **COMPLETED SUCCESS, 7/7 jobs**, Node24 **2,341 total / 2,049 PASS / 0 FAIL / 292 SKIP**.

## Limits

- GitHub-hosted Windows runner and disposable SQLite tests are **not** the registered NAVEAX / Work-PC physical reboot, owner consent, UAC/ACL/DPAPI, credential custody, or full CORE acceptance.
- Journal owner `src/agent/operation-journal.ts` calls `verifyAgentJournalWal` and `new DatabaseSync(path)` in separate steps. This cannot guarantee atomic identity/namespace continuity nor prevent a double-deleted WAL/SHM rollback without a separately trusted reservation witness.
- The repository was read via GitHub connector; local full clone/`npm ci`/`npm run build` are not claimed. Independent AI-08 adversarial QA and coordinator's integration remain open. Production **NO_GO**.
