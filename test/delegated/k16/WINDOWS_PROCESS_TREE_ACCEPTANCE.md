# #540 / #539 R07 — Windows process-tree acceptance handoff (K16)

Source baseline: `Naveax/Nexowire main` `4e7db16f4233048a956664bef6b607781eb63fb7` (2026-11-07).
Owner integration: Draft #1096 (ProcessManager and Windows Job handling); verify its **new exact HEAD** before testing.

This is a test contract, not evidence that any real Windows process was stopped.
K16's `windows-taskkill-contract.test.ts` invokes the existing private `killPidTree()`
source in a VM with a fake `spawn` and fake PID liveness. It proves only these
source-level outcomes:

| Synthetic result | Root state | Expected API evidence |
| --- | --- | --- |
| `taskkill` exit nonzero | Root still alive | `PROCESS_TREE_TERMINATION_UNCONFIRMED` error |
| `taskkill` spawn error | Root still alive | `PROCESS_TREE_TERMINATION_UNCONFIRMED` error |
| `taskkill` exit nonzero | Root already gone | `treeCleanup=unconfirmed` (never success) |
| `taskkill` exit zero | Root appears alive | `treeCleanup=requested` only; descendants not verified |
| `taskkill` exit zero | Root exited, *owned grandchild remains alive* | `treeCleanup=requested` **cannot mean succeeded**; grandchild postcondition missing (#540 T-387) |
| `taskkill` exit nonzero | Root exited, *owned grandchild remains alive* | `treeCleanup=unconfirmed`; parent exit cannot prove tree exit (#540 T-387) |
| `taskkill` exit 128 | Original root exited but numeric PID **reused**; owned grandchild alive | `PROCESS_TREE_TERMINATION_UNCONFIRMED`; PID-only liveness never proves original identity (#540 T-486) |
| `taskkill` exit null | Original root exited, owned grandchild alive | `treeCleanup=unconfirmed`; missing exit status is not a confirmed stop (#540 T-486) |
| `taskkill` exit zero | Original root exited, numeric PID now belongs to unrelated process | `treeCleanup=requested` **not** verified; this fixture does not signal/kill live PIDs (#540 T-486) |

## Real Work-PC acceptance required by #540

Only the Windows/process owner may run these cases in an **isolated owned test
session**. Never enumerate a PID and blindly kill it; reuse and unrelated user
processes must be excluded by ownership and creation-time evidence. Capture:

1. **Build identity:** exact installed source SHA, binary digest, Windows build,
   Node version, Worker/Job mode, test start/end timestamps.
2. **Process identity:** managed session ID, root PID and creation time,
   descendant PID/parent relationships and creation times, explicit evidence
   that every target belongs to this test's process tree.
3. **Termination:** `taskkill`/Job request result and exit code (when relevant),
   redacted bounded error text, `stop()` result/error code and `treeCleanup`
   value. Distinguish `requested`, `unconfirmed`, and actually verified exit.
4. **Postcondition:** independently re-enumerate the owned root/descendants
   after a bounded wait; record that **all** exact owned process incarnations
   exited. A process-tree request exit code of zero alone is insufficient.
5. **Runner completion:** the isolated `process-manager.test.ts` command must
   itself exit `0` with a final TAP summary; 11 passing assertions plus a hung
   test process is a **failure**, not PASS.
6. **Negative cases:** parent exits before stopping grandchild; detached shell
   descendant keeps stdout/stderr open; simultaneous restart; stop after exit;
   reused PID; Job handle not closed; failed `taskkill` and spawn error.
7. **Safety:** record evidence that pre-existing user processes and unrelated
   services were neither signaled nor stopped. Redact secrets, account paths,
   environment variables, and command-line arguments from shared artifacts.

## Completion rule

### #540 T-487 — owner handoff evidence matrix

| Gate | Required real Windows observation | When missing / contradictory |
| --- | --- | --- |
| Identity | Session owner plus root and *each* descendant PID **and creation time** before stop; exclude unrelated/reused incarnations | `UNKNOWN`, no action on ambiguous ownership |
| Job readback | Owner #1096 native Job handle/result and its assignment/closure evidence for this exact session | `NOT_RUN` if no readback; `FAIL` if readback disproves assignment |
| Stop request | Bounded `taskkill` or Job return/error with exact source SHA and timestamps | `requested`/`unconfirmed`, **never** `succeeded` alone |
| Independent exit | Re-enumerate exact owned process incarnations after bounded deadline, including grandchildren and detached shells | `FAIL` if still live; `UNKNOWN` if evidence or identity incomplete |
| Test completion | Windows Node 22/24 (as actually configured) process exit 0, full TAP final line, no skip/TODO; include tested test path | `NOT_RUN` if test not discovered, even if general CI 7/7 |
| Unrelated-process safety | Unrelated pre-existing PIDs/creation times unchanged; no signal outside owned session | `FAIL` on collateral termination, no source-only waiver |

See `WINDOWS_HOSTED_CI_DISCOVERY.md`: historical successful #1105 CI
did not discover K16 nested `.test.ts`, so it cannot satisfy the test gate.

### #540 T-629 — owner-only leaked-descendant trials

For each trial, capture root and **every** descendant PID+creation time before
the stop, including a detached child/grandchild. Do not look up or signal
unrelated live PIDs for fixture preparation. In a disposable owned session only:

| Scenario | Negative postcondition to reproduce | Acceptance |
| --- | --- | --- |
| Root exits ahead of its child | Child owns an open stdout/stderr handle after root exit | `FAIL` if any exact owned descendant still runs after deadline |
| `taskkill` returns zero | Grandchild survives with the same original PID+creation time | Never promote `treeCleanup=requested` to verified |
| Root PID recycled | New unrelated incarnation appears at the same PID while original grandchild stays live | `UNKNOWN` root identity; no signal to unrelated incarnation |
| Access denied / exit 128 | Owned child still live after stop attempt | `FAIL`/`unconfirmed`, record bounded error and retry policy for owner review |
| Job handle released unexpectedly | Guardian/parent exits but child remains outside expected Job closure | `FAIL`; owner must inspect actual native Job readback |
| Child exits cleanly, handle drained | All exact owned incarnations independently absent and TAP command exit 0 | Source/process proof only; full Work-PC acceptance still separate |

Do not equate an exited shell, an empty `taskkill` stdout, a synthetic PID
fixture, or a green unrelated CI job with an observed all-descendant exit.
On an unknown incarnation, stop the trial and leave the gate `UNKNOWN`.

The owner must link the exact-HEAD Windows CI result, the full isolated test
process exit, and independent descendant-exit evidence to #540. If any owned
descendant remains, identity is ambiguous, or a case is not run, keep that gate
`FAIL`/`UNKNOWN`/`NOT_RUN`. Do not close #540 or claim installed-device
resolution from K16's Linux/VM fixtures or from a successful `taskkill` request.
