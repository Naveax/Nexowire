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

The owner must link the exact-HEAD Windows CI result, the full isolated test
process exit, and independent descendant-exit evidence to #540. If any owned
descendant remains, identity is ambiguous, or a case is not run, keep that gate
`FAIL`/`UNKNOWN`/`NOT_RUN`. Do not close #540 or claim installed-device
resolution from K16's Linux/VM fixtures or from a successful `taskkill` request.
