# P0 #402 + PR #579: Windows browser-live owned process and profile cleanup

## Original CI evidence (not inferred from source CI color)

- GitHub Actions run `39175699760`, **attempt 1**, Windows job `browser-live`, failed in `test/browser-live.test.ts`.
- The fixture's headless Edge page acceptance reached the test end. Node reported `EBUSY` on `unlink` of the `lockfile` inside a unique temporary `nexowire-browser-live-<random>/<session UUID>` directory, during `t.after`.
- Pre-fix `BrowserManager.terminate()` invoked Windows `taskkill /PID ... /T /F` but returned after taskkill exited, with no positive process-identity check and no browser handle/lock release verification. Its `stop()` silently ignored failed profile removal; `stopAll()` used `Promise.allSettled` and discarded rejections. `t.after` immediately recursively deleted the parent fixture.
- These are confirmed teardown-contract defects. The actual kernel file-handle owner was **not** captured from attempt 1, so it is not rigorously attributable to a specific surviving Edge subprocess. Concurrent GitHub jobs have their own `windows-latest` runner and this fixture uses unique temp/profile names; no log evidence implicates cross-job profile collision.
- Attempt 2 of the old exact SHA was already queued by another concurrent workflow during this investigation. It is **not** evidence of a fix.

## Changes to verify

1. For Windows headless Edge/Chrome, a process ID alone is no longer authorization to kill. Read-only native `Win32_Process`/CIM must show **exact PID, executable pathname and the generated `--user-data-dir`** before a bounded `taskkill /T /F` of that session-owned PID. For a private desktop browser, the active NexowirePrivate launched-PID inventory must attest the target. Unknown or foreign identity fails closed.
2. Bounded verification waits for Node child exit after `taskkill`. Profile cleanup only accepts one UUID child of the configured root, checks parent and profile link identity, then retries `EBUSY/EPERM/EACCES/ENOTEMPTY` for no longer than a small fixed window. Exhaustion is **`BROWSER_PROFILE_CLEANUP_FAILED`**, never silently swallowed. No global process kill or broad temp-dir delete.
3. `BrowserManager.stop()` removes ownership/session state only after successful cleanup. `stopAll()` propagates errors instead of claiming success after `allSettled`. Start failure cleanup also reports independent teardown failures, rather than replacing evidence with apparent success.
4. The browser-live fixture explicitly asserts `stopped=true` and `removedProfile=true`, then removes **only its now-empty owned test root**. The local HTTP listener is closed in `finally`, even if the teardown fails.
5. Windows `browser-live` CI stage now runs explicit negative tests `test/browser-session-cleanup.test.ts` before real Edge. Tests cover transient and permanent EBUSY, foreign profile / symlink, PID/executable/profile mismatch and cleanup error propagation.

## Local Windows evidence and limits

- Work PC tests use **headless** Edge against an ephemeral HTTP server only, no GUI focus, owner `Default` input, visible window, user pointer or keyboard mutations.
- Existing PR #579 generated PowerShell helper byte-pinning and private UIA fail-closed logic are unmodified. Keep original WPF, WinForms, Common Item Dialog read-only, window/process/session grants and emergency-stop negatives.
- CIM+PID verification before `taskkill` is not an atomic Windows process HANDLE/kernel provenance mechanism: PID reuse in the tiny verification-to-kill interval and post-termination children remain residual risk. Production approval requires native handle-based process membership/Job proof, durable containment, and owner-active acceptance.
- Do **not** treat green local tests or green source-only CI as production isolation proof. No `main` merge, live Agent/Broker update, user Default desktop automation or blind retry of unknown mutations.

## AI Screen launch-sink review

The extra direct `src/agent/browser-manager.ts#spawn` is solely a **bounded read-only process-identity query** of a verified positive integer PID, using a fixed `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` and `Get-CimInstance Win32_Process -Filter "ProcessId = <PID>"`. No user-supplied PowerShell commands, interactive window focus, browser control, WSL route or COM mutation are exposed through this callsite. It collects only the PID/executable/commandLine necessary to attest the **unique BrowserManager-owned UUID profile** before `taskkill`. Query timeout and missing/mismatched evidence fail closed; the process is not killed. This new native process spawn still merits review for PowerShell runtime integrity and PID-reuse TOCTOU, and **does not attest GUI/Default-desktop isolation**.

Explicit inventory review: `scripts/ai-screen-launch-sinks-baseline.json` raises `src/agent/browser-manager.ts#spawn` from 2 to 3 for this specific callsite, leaving the audit enforced for future unreviewed changes. The baseline update is **not** permission to launch GUI through ordinary shell wrappers.
