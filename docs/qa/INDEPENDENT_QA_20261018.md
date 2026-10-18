# Cross-project independent QA acceptance | 18 October 2026

Independent read-only audit baseline: `a54cbbdd37e981a169631d688b53c7e3b3e90f48`. Worktree: `test/parallel-16-independent-qa-20261018`.
This is a **gate and fault-injection ledger**, not a product-fix declaration.

## PASS semantics

Each R01–R22 has four independent statuses in `cross-project-final-acceptance.json`: source, staging, production and original incident. `PASS` requires level-specific evidence and the exact tested SHA. Source-only green CI never closes a physical original incident. `NOT_TESTED` is distinct from `FAIL` and `BLOCKED`. GitHub PR merges do not automatically modify this ledger. Tests deliberately reject a synthetic final PASS with missing lower stages.

## Source / CI audit at baseline

- `main` moved from `8bf7ce1` to `a54cbbd` during the audit as #543 merged. Worktree aligned to `a54cbbd` before changing files.
- CI workflow includes Ubuntu Node 22+24, Windows, Linux native, real WSL2 Ubuntu and macOS native. At inspection, main run `39133662035` still had Windows `browser-live` in progress. **Do not count the overall run as PASS until completed.**
- Historic source CI `39116300377` completed successfully for `8bf7ce1`; it does not prove a live Agent upgrade. #538 and #542 cover Agent journal and shell-result reporting only.
- The Windows Process Manager #543 is merged. `taskkill /T /F` returning success is a request acknowledgment, not independent descendant attestation. The issue remains OPEN until Job Object containment and real orphan cleanup are proven.
- No source CI gives independent production OAuth/24-hour quota/cloud-cost/physical gamepad/GUI focus evidence.

## Critical original negative reproductions

| Fault | Required assertion | Existing/QA source test | Physical release gate |
|---|---|---|---|
| MUTATION_STATE_UNKNOWN | No blind mutation retry; offline result stays UNKNOWN | `test/qa-agent-journal-negative.test.ts` | Restart real Agent during lost-ACK and reconcile |
| Shell transport OK but exitCode=7 | `taskSuccess:false`; no user-facing PASS | `test/qa-shell-outcome-negative.test.ts` | Real CMD/PowerShell/WSL negative exit |
| Windows killed parent, live child | `unconfirmed`; no tree-clean PASS | `test/process-manager-tree-cleanup.test.ts` | Windows Job Objects for race-free ownership |
| PATH_DENIED / USB | No shell/WSL privilege bypass | `test/path-policy.test.ts` | Physical USB volume identity and ACL |
| Permission / ROOT / CORE | Missing grant denies, explain no action | `test/windows-console-grant.test.ts` | Owner physical console and UAC |
| Connection loss | Reconnect no mutation auto-replay | `test/native-session-continuity.test.ts` | Two real hosts/off-network |
| Bot stuck RUNNING | Unknown/stuck, no fabricated completed percentage | `test/task-artifacts.test.ts` | Actual model completed count and artifact SHA |
| Corrupt artifact | No succeeded task if artifact missing | `test/task-artifacts.test.ts` | Transfer and compare across chats/devices |
| OAuth AuthRequiredError | Independent Codex vs ChatGPT issuer/scope proof | `test/mcp-oauth.test.ts` | Live Codex CLI / issuer discovery |
| GUI focus drift | Deny HWND owner mismatch | `test/private-uia-mixed-owner-isolation.test.ts` | Physical Windows native dialog and focus change |
| 24h Scale v2 | Benchmarks not production evidence | `test/owner-quota-local-capacity-benchmark.test.ts` | 100+ sockets, 600/min, 850k/day and cloud cost |
| CI green only | Four-gate release remains BLOCKED | `test/qa-final-acceptance-negative.test.ts` | Independent original incident re-run |

## PR correspondence

| PR | Original issue | Reproducer | What still blocks original incident closure |
|---|---|---|---|
| [#538](https://github.com/Naveax/Nexowire/pull/538) | Lost ACK / journal | Agent journal restart + MCP mutation failure | Real upgrade/reconciliation on both devices |
| [#542](https://github.com/Naveax/Nexowire/pull/542) | False shell PASS | Provider returns `ok:true,exitCode:7` | Live Windows/WSL consumers must check `taskSuccess` and postconditions |
| [#543](https://github.com/Naveax/Nexowire/pull/543) | Orphan child process | Lost parent and surviving uniquely marked node child | Windows Job Object lifetime + crash-proof ownership |
| [#480](https://github.com/Naveax/Nexowire/pull/480) | GUI isolation | `bash` broker direct-launch path | Foreground HWND, multi-display, COM/UAC physical acceptance |
| [#537](https://github.com/Naveax/Nexowire/pull/537) | Public signed WSS | Signed nonce replay rejected by isolated fixture | Named tunnel, real OAuth, broker, 24-hour quota and independent ISP |

**Blocking release findings**: R07 child ownership not proven; R12 sustained real quota/throughput not demonstrated; R15 original cross-chat artifact retrieval not demonstrated; R18 original stuck-bot recovery not demonstrated; R22 physical release gates incomplete. These findings block **overall acceptance**, not necessarily the narrow isolated changes in each draft PR.

All 12 historic project classes are mapped to individual requirements in the machine-readable JSON. Re-test the exact incidents after source/staging deployment. Third-party policies, UAC and firmware issues cannot be bypassed by Nexowire.

## New independently checked PR intake | 20 entries

The machine-readable `PR_SOURCE_AND_RELEASE_GATES.json` now records 20 known PRs (#480, #537, #538, #542, #543 and #545-#559). Each is tied to an exact source SHA, repro test and missing *physical* acceptance. This is a dated snapshot, not an ongoing live poll.

**Blocking exact-head CI regressions:**

- [#551 workflow 39135168316](https://github.com/Naveax/Nexowire/actions/runs/39135168316): Ubuntu Node24 job 117698096540 failed existing `console-ui-polish.test.ts` callback redirect regex. Regression may reflect changed POST trust contract rather than insecure behavior. Correct the legacy acceptance and re-run CI.
- [#553 workflow 39135602721](https://github.com/Naveax/Nexowire/actions/runs/39135602721): Ubuntu Node24 job 117699532080 has multiple task-graph/artifact/execution failures; WSL2 job 117699532117 failed `PATH_DENIED`; native Linux job 117699532174 and macOS job 117699531828 failed `UNSANDBOXED_EXECUTION_DENIED`. Security behavior is intended fail-closed but the current full build regresses supported native cases. **No wildcard authorization bypass is acceptable as a fix.**
- [#559 workflow 39137327997](https://github.com/Naveax/Nexowire/actions/runs/39137327997): exact-head CI passed. It does not verify *deployed* Win32 Job Object guardian ownership or original incident. #559 remains DRAFT.
- [#558 workflow 39135829286](https://github.com/Naveax/Nexowire/actions/runs/39135829286): exact-head CI passed. It does not verify crash/reconnect in an upgraded Agent/Hub.

**Independent Windows source regression:** existing eight scoped suites `process-manager-tree-cleanup`, `agent-operation-journal`, `agent-provider-task-outcome`, `mcp-post-mutation-journal-failure`, `path-policy`, `private-uia-mixed-owner-isolation`, `mcp-oauth`, `task-artifacts` passed **44/44** against `a54cbbd` before the latest integration merge. Newly authored QA negative files passed **15/15** plus later approval-only gate 8/8 on the isolated Windows worktree, with typecheck/build/continuation PASS. CI after rebasing must validate again.

**Integrity limitation:** this draft gate validates status/evidence structure; an `independentReleaseApproval` object alone is **not** a cryptographically verified signature or production attestation. Source test assertions cannot autonomously establish trusted reviewer identity, external ISP, physical hardware or historical incident closure. Such evidence must be verified out-of-band before release.
