# #540 / #539-R07 — Windows descendant-process acceptance

T-370 read-only acceptance specification from live [#540](https://github.com/Naveax/Nexowire/issues/540) and `main` `4e7db16f4233048a956664bef6b607781eb63fb7` on 2026-11-07. Not a ProcessManager fix or a Windows acceptance run.

## Reproduction and current implementation distinction

- Owner's 2026-10-18 physical Work-PC run reproduced descendant leakage: `test/process-manager.test.ts` logged 11/11 assertions passing **but the TAP process remained running**, consistent with inherited open pipes/grandchildren. Passing 11 assertions is not proof that the run exited cleanly.
- Current `src/agent/process-manager.ts` already checks Windows `taskkill.exe /PID … /T /F` result/timeout, uses guarded Windows Job stop paths, and returns `treeCleanup: 'requested' | 'unconfirmed'`. The code explicitly says `'requested'` **does not certify that all descendants were reaped**. Do not reimplement these CORE changes in delegated files.
- `test/process-manager-tree-cleanup.test.ts` already has two Windows-only tests: (1) uniquely marked child stopped with root; (2) root deliberately lost and Windows Job closes its descendants. Both are marked `skip: process.platform !== 'win32'`. Linux execution is **SKIP**, not Windows PASS.
- Owner's open Draft [#1096](https://github.com/Naveax/Nexowire/pull/1096) overlaps `src/agent/process-manager.ts`; K20 has no edit/merge authority there.

## Necessary evidence before marking #540 fixed

| Gate | Physical Windows evidence needed | False-positive to reject |
| --- | --- | --- |
| Exact ownership | Unique test marker, owner Job/session ID, root PID **and creation time**, identified descendant PID **and creation time** before stop | PID-only identity, global process enumeration followed by broad kill |
| Stop call | `taskkill` or native Job stop exit/status, timeout, explicit API error on unconfirmed termination | Assuming command dispatch/parent gone means success |
| Postcondition | Targeted `Win32_Process` readback that every owned grandchild PID+creation-time pair has exited, including reparented cases | `treeCleanup: 'requested'` alone |
| Lost-parent | Kill only owned synthetic root, verify Job handles descendants even when `/T` no longer has root PID | Cleanup succeeds only while parent remains alive |
| TAP exit | `node --test` command itself terminates with exit code 0 within bounded time; no lingering pipes/handles | 11/11 printed yet runner hangs |
| Repeatability | Multiple bounded fresh marked runs, including forced timeout/error and existing-root scenarios, with logs and timestamps | One fixture run or a mocked success branch |
| Scope | Distinguish durable vs non-durable session, direct children vs grandchildren; never terminate unrelated user processes | Blind `taskkill` for any PID or stale/reused PID |

**Acceptance status at audit:** Owner's earlier physical failure is documented; current main source and Windows test cases exist. **NEW PHYSICAL WINDOWS PASS: NOT_RUN by K20.** No claim that #540 is closed, the original real-PC hang is fixed, or release is approved. Windows process-manager changes belong to Ömer/owner #1096. K20's offline tests exercise only the acceptance/CI evidence classifiers.
