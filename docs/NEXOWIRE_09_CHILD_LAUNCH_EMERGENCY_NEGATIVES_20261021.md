# #09 P0 #402: independent forged child-launch and emergency-stop source acceptance

Parent PR #663 HEAD `508cc0870699b58d384f04fcb6b675a4dfac0a87`.

## First: exact-head CI diagnosis, before edits

- GitHub Actions #39631336087 overall **FAILURE**.
- **Windows `browser-live` job SUCCESS**, including native Job guardian, Windows Job fast-exit, `test/private-desktop-owner-fence.test.ts`, CORE/private GUI broker, picker grant and Windows control regressions.
- Node22/24, Linux, WSL2 and security-operational jobs all **SUCCESS**.
- `macos-agent-lifecycle-live` **CANCELLED**, not `FAILURE`. GitHub's decoded log endpoint for that cancelled job reported an expired/unavailable log artifact (`BlobNotFound`); the cancellation cause is therefore unknown. Do **not** call this an inherited Windows Job failure and do **not** claim full CI green. No test skip or CI job cancellation suppression introduced.
- #19 independent Windows Job 100-cycle fast-exit PASS is narrower than protected signed publisher and inherited parent ACL acceptance; those remain separately red/NO-GO.

## Source additions

New `PrivateDesktopChildLaunchReceipt` and `PrivateDesktopChildKernelWitness` compared to a protected parent witness through `assertPrivateDesktopChildLaunchProvenance`. Negative cases cover:
- forged `stdout`, `exitCode=0` and child PID whose **kernel parent PID + creation FILETIME** do not match protected original
- a reused child PID with different creation FILETIME, wrong Windows session/desktop, missing Job membership, stale guardian creation timestamp or unrelated Job handle ID
- duplicate/malformed launch request ID, fake original parent lineage, owner epoch/re-pair and cancellation epoch mismatch
- source-only positive synthetic proof remains an **inert frozen record** without `taskkill`, HANDLE or CORE elevation authority

New `assertPrivateDesktopEmergencyStopFence` refuses **NEW** private GUI, child launch and picker mutation intents whenever emergency stop is pending, owner/cancel epoch advances or input desktop ceases to be exactly `Default`. If a native write may already have started, outcome is **UNKNOWN, never undone or automatically replayed**. Emergency protected OS cleanup must use a separate #03 verified Job-owner path, not this source contract. Tests verify an injected mutation callback stays **uninvoked** after cancellation and that a forged request ID is rejected. No physical keys, mouse, foreground or Secure Desktop UAC were used.

### Important non-authoritative evidence boundary

The pure source contract only validates field consistency. All `collectorVerified`, parent creation FILETIME, native HANDLE/Job membership, and launch ancestry facts **must** be independently attested by an OS-protected, signed native #03 collector. Caller-supplied JSON can forge every boolean; these are NOT standalone cryptographic proof. The runtime `src/agent/windows-private-desktop.ts:killTree(pid)` still calls **PID-only** `taskkill.exe /PID ... /T /F` and **does not call this module**. Therefore production private-desktop child termination and emergency-stop OS side-effect cancellation remain **BLOCKED**.

## Continued acceptance and blockers

- Parent #663 source safeguards preserved: helper SHA-256 tamper prevention, private HWND/PID/session and picker grant fail-close, direct CMD/PowerShell/WSL/Terminal known literal broker rejection, signed CORE Broker preapproved-only permission policy.
- Actual protected signed Broker publisher and parent ACL evidence red in other Windows Job/installer suites; do not infer true CORE authority from any synthetic fixture.
- True Explorer/COM cross-PID picker acceptance, native child process Job handle ownership, independent signed and protected helper postcondition, physical UAC secure-desktop and user-active second-display soak remain production **NO-GO**.
- #480 old overlap patch already equivalent in main; do not merge. No live Agent/Hub/Broker, service, VM, UI, UAC, mouse, keyboard, Default focus, production UI or `main` merge.
- New exact-head GitHub CI must be checked separately. If unrelated macOS cancellation repeats, report it, not a Windows failure.
