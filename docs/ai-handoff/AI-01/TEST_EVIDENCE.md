# AI-01 | TEST_EVIDENCE

## Latest verified source baseline

| Item | Exact evidence |
| --- | --- |
| Repo / Draft PR | `Naveax/Nexowire`, [#986](https://github.com/Naveax/Nexowire/pull/986), branch `ai/01-wal-v108` |
| Base SHA | `a19a228dc6f19fd484cf935e941a00ea625233f8` |
| Latest source/test HEAD | `eaff829784f10306066cc4714a2eaa3b7cc79282` |
| Exact-HEAD CI | [run #41243619101](https://github.com/Naveax/Nexowire/actions/runs/41243619101), **COMPLETED SUCCESS, 7/7 jobs** |
| Node 24 job | `124662419848`, **2,339 tests / 2,047 PASS / 0 FAIL / 292 SKIP / 0 TODO** |
| Node 22 job | `124662419800`, **SUCCESS**, full checks/build and AI-01 negatives `ok` |
| Windows browser-live | `124662419597`, **SUCCESS**; `npm run typecheck` and recycled WAL/consecutive journal process restart step SUCCESS |
| Other jobs | Linux-native, WSL2, macOS agent lifecycle, security-operational **SUCCESS** |

Evidence originates from the exact GitHub Actions job logs/steps for `eaff829784f10306066cc4714a2eaa3b7cc79282`, not a local `npm ci`/clone. This delivery-docs-only successor HEAD must have its **own CI** checked independently.

## Disposable WAL coverage

- **16 isolated `test/ai01-wal-snapshot-races.test.ts` cases:** SQLite-authentic hot/recycled/empty WAL positive checks; post-scan WAL-header and SHM mutation; POSIX pathname/inode swap including byte-identical file; recycled truncated frame and partial appended frame; damaged current salt; `UNKNOWN` preservation and request ID non-replay on independent SQLite reopen; checksum-valid but uncommitted final frame; pre-open WAL truncation; byte-identical SHM timestamp drift; and WAL/SHM disappearance after first `lstat` but before `open`.
- The last two negatives assert stable `AgentJournalWalError.code = AGENT_JOURNAL_WAL_CORRUPT` rather than a raw `ENOENT`. Ordinary WAL absence at the initial `lstat` is still permitted.
- The same-source [job log](https://github.com/Naveax/Nexowire/actions/runs/41243619101) explicitly lists the four newest pre-open negative cases as PASS in Node 24 and `ok` in Node 22. **No negative skips or weakened assertion were introduced.** POSIX open-file rename test skips on Windows remain explicitly OS-dependent, not physical Windows PASS.
- Original cross-suite regression fixture `test/agent-journal-restart-regression.test.ts`: 709 current + 295 retained old-generation WAL frames, 473 commit-marked frames and 1,307 synthetic journal rows. Six simulated crash/restarts plus one clean restart; retained `UNKNOWN` / duplicate request ID denial. Shared fixture file remains unchanged by AI-01.
- Existing `test/qa-journal-wal-recycle-p11.test.ts` verifies SQLite-authentic RESTART/reuse, multiple old generations, checksum/salt/frame geometry and WAL-index mismatches. Its source was not modified.
- Tests use disposable SQLite files; the verifier itself does not delete, checkpoint, truncate, reset credentials or mutate the user's journal.

## Historical failure attribution (never rewritten as PASS)

- [run #41197139627](https://github.com/Naveax/Nexowire/actions/runs/41197139627), source SHA `f33bc494fe4efe2a75d5a4a91917661afba8fa4b`: original Windows `browser-live` attempt timed out on IPC worker in coordinator-owned `test/agent-journal-restart-regression.test.ts:44` with empty stderr. Direct corrupted-WAL rejection succeeded. **Only the failed job** was rerun, and the same run ID reached final **7/7 SUCCESS**. The precise first-attempt worker hang was not proved from the logs; tests/timeouts were not relaxed.
- [run #41199721229](https://github.com/Naveax/Nexowire/actions/runs/41199721229), docs-only SHA `0f6e35e5abbd0bfee006e0757f7477c2f69b2834`: **7/7 SUCCESS**.
- [run #41211304023](https://github.com/Naveax/Nexowire/actions/runs/41211304023), source SHA `9b6464f034d67d3ade059585fe8739932733f319`: **7/7 SUCCESS**, Node 24 **2,337 / 2,045 PASS / 0 FAIL / 292 SKIP**. Pre-open WAL truncation and SHM metadata race negatives PASS.
- [run #41243619101](https://github.com/Naveax/Nexowire/actions/runs/41243619101), current source SHA `eaff829784f10306066cc4714a2eaa3b7cc79282`: **7/7 SUCCESS**, Node 24 **2,339 / 2,047 PASS / 0 FAIL / 292 SKIP**. Two additional observed-then-vanished WAL/SHM diagnostic negatives PASS.

## Evidence limits / blockers

- CI Windows tests are GitHub-hosted runner/contract evidence, **not** the user's registered NAVEAX/Work-PC physical proof. No live journal, Agent restart, UAC, DPAPI, ACL, real session/owner, CORE execution, device enrollment, or 24h soak was performed by AI-01.
- `verifyAgentJournalWal` cannot make the separate `AgentOperationJournal.initialize()` call to SQLite's `new DatabaseSync(path)` atomic; the final path readback is not an independently trusted rollback/replay authority.
- Full clone and local `git status`/`npm ci`/`npm run build` were unavailable in this runtime. GitHub source, per-file diff, exact CI SHA and runner logs are used instead.
- AI-08 independent exact-HEAD/combined integration QA and coordinator-owned journal API change remain open. Source-only `READY_FOR_REVIEW`; production `NO_GO`.

## Pending orphaned WAL/SHM fail-closed regression (new source commit)
- Independent, disposable SQLite WAL-mode reproduction: checkpointed base contained `old=committed`, a later WAL-only `new-unknown=unknown`; deleting WAL while leaving SHM made a normal SQLite reopen return only `old`. This is a data-loss/replay risk for the Agent journal, **not** a physical user database finding.
- The previous verifier returned success on the initial `-wal` ENOENT and did not check the orphaned `-shm`. Candidate fix refuses that state with `AGENT_JOURNAL_WAL_CORRUPT`; a genuine clean/brand-new journal with both sidecars absent still passes.
- Two new deterministic disposable tests are appended to the AI-01 suite; no existing assertions are relaxed or skipped. **These two cases must not be claimed PASS until the new exact-HEAD CI succeeds.** Parent documentation-only SHA `7875ba77fe0f33be393cbf3c49d16ae9e839b5ff` has its own CI tracked independently.
- SQLite upstream reference: https://www.sqlite.org/wal.html and https://www.sqlite.org/tempfiles.html (WAL contains persistent DB state and sidecar lifetimes). No live device/Agent/credential actions.
