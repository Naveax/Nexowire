# P1 Windows Process Manager stop: truthful cleanup outcome (issue #541)

**Release state:** Source-only diagnostic mitigation, not a complete orphan-process fix or Windows Job Object implementation.

## Verified problem

On Work PC in a 39-file Agent/MCP regression, all 11 `process-manager.test.ts` cases printed PASS but Node test process did not terminate. Win32 process inspection identified orphan `node -e "setInterval(() => {}, 1000)"` descendants with parents already gone. Those precise test-owned PIDs were separately verified and removed. This is evidence of real process-child cleanup uncertainty, not proof that the Agent or user's other applications failed.

`ProcessManager.stop()` called `taskkill.exe /PID <owned-root> /T /F` but discarded exit codes and spawn errors. It then verified only the root PID and could mark session `exited` even if children remained.

## Scoped mitigation

- Windows `taskkill` now has a 10-second timeout and its exit status is checked rather than silently ignored.
- If `taskkill` does not succeed and the original PID remains alive, stop throws `PROCESS_TREE_TERMINATION_UNCONFIRMED`, without claiming cleanup success.
- If the root PID has already vanished, stop returns **`treeCleanup: 'unconfirmed'`**, because `taskkill /T` cannot reliably resolve prior descendants.
- When `taskkill` exits zero, stop reports **`treeCleanup: 'requested'`**, meaning only that Windows accepted the tree-kill invocation. It does **NOT** mean each descendant was independently verified as terminated.
- An alive root after a bounded stop attempt returns `PROCESS_ROOT_TERMINATION_UNCONFIRMED`.
- The `waitForChildClose` timeout listener is removed when the wait resolves or expires, avoiding an accumulating stale `close` listener.
- Non-Windows process-group handling and durable worker control remain unchanged.

## Bounded Windows tests

`test/process-manager-tree-cleanup.test.ts` runs two separate physically checked cases:

1. Launch a short-lived **unique-marker Node child** under an owned PowerShell root. Stop with `taskkill /T`, check return `requested`, and verify that that child is gone.
2. Launch another unique-marker child; kill **only its exact owned shell PID**, without `/T`, reproducing a lost parent. Calling `ProcessManager.stop()` must report `treeCleanup: 'unconfirmed'`; child survival is deliberately observed, then the test deletes **only the exact marker-matching PID and creation timestamp**. No broad process cleanup or change to live Agent services.

Windows acceptance so far: 2/2 targeted physical test scenarios passed; **40 related Agent/MCP test files excluding the known batch-hanging historical process-manager test: 206/206 passed**; typecheck, build, continuation, launch audit and whitespace checks passed. AI Screen warning about pre-existing child process launch isolation remains unchanged.

## Remaining release gates

**#541 stays open** until a real Windows Job Object or equivalent reliable lifetime ownership strategy is implemented. The full single-file `process-manager.test.ts` passed 11/11 under live streamed output on one earlier run, but combined runs showed orphan leakage. The new code does not guarantee orphan cleanup, cannot certify a whole subtree from one `taskkill` exit code, and does not replace independent PID identity checks or physical Windows execution acceptance. Do not treat source merge as deployed runtime protection.
