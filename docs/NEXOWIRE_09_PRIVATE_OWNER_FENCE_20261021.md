# Nexowire #09 source-only private desktop owner/Job provenance acceptance

Parent: #624 `26cfad8228bdb24147a746c0dde44e4c8f78a709` CI #39608661483 **SUCCESS**. This branch changes only a new **pure non-executing provenance contract**, new synthetic negative tests, CI test wiring and this document. #03 owner files and installed Agent/Broker/Job remain unchanged.

## New policy boundary

`src/agent/private-desktop-owner-fence.ts` defines `PrivateDesktopLaunchIdentity`, `PrivateDesktopKernelWitness` and a verification gate that matches:
- PID **and immutable Windows process creation FILETIME**, exact owner Windows session and private desktop generation
- guardian PID **and its own creation FILETIME**, unnamed Job handle identity, verified guardian kernel Job membership and protected local collector
- current owner epoch and cancellation epoch (re-pair/revoke/emergency stop), observed input desktop `Default`, private target desktop `NexowirePrivate` and running state
- two independent witness reads, refusing any identity, cancellation or secure-desktop transition between them

The contract returns **an inert, frozen proof record**, never a process HANDLE, GUI mutation, TaskKill permission, elevation or UAC consent. Its `collectorVerified`, `guardianJobVerified` booleans are **not self-attesting**. They MUST originate from #03's protected OS kernel evidence and immutable Job/process HANDLE; arbitrary caller JSON can forge them. No self-reported proof is an authorization.

**Important unclosed P0:** real `src/agent/windows-private-desktop.ts:killTree(pid)` still calls PID-only `taskkill.exe /PID /T /F` without calling this gate or binding a Windows process HANDLE/Job. Source negative test explicitly confirms it is **unintegrated**. Replacing that runtime path safely belongs with #03 Job owner. This branch does not execute it on a foreign PID. No signed Broker privilege path or CORE authority has been restricted/removed.

## Negative acceptance (all synthetic, CI and Work PC)

- Same PID with a changed creation FILETIME; malformed or missing process creation time, unknown Job owner or guardian handle
- guardian restart / PID reuse / changed guardian creation FILETIME, Job identity mismatch or job membership unknown
- foreign Windows session/desktop generation, COM child on `Default` or `Winlogon`, process `unknown`/exited
- owner epoch revoke/re-pair, cancel epoch increments / emergency stop between two independently collected witnesses
- input desktop `Winlogon`, secure desktop, untrusted unknown input desktop; never click through UAC
- Explorer cross-PID file picker / stale grant: no edit, invoke, focus, keyboard or mouse; CMD+COM+WSL+Terminal literal wrappers denied
- read-only source check flags the still-unverified `killTree` implementation, never treats PID-only stop as safe

## Exact-head status and production blockers

Check exact GitHub Actions CI at the final SHA. Existing #624 CI is green, but **not** proof for this branch. Physical WinSta0 interactive acceptance is **not** run here. Even when source CI passes, this contract is test infrastructure; **production remains NO-GO** pending:
1. #03 kernel Job process HANDLE creation-time provenance wired atomically into the actual private desktop launch, child tracking, cancel and stop (not PID-only TaskKill)
2. protected signed elevated Broker exact publisher/ACL/image chain, actual owner-approved CORE token and revoke semantics, no generic GUI escape or per-command UAC bypass
3. Explorer/COM cross-PID native picker positive file acceptance in authorized isolated session; unknown side effect no replay
4. real secure desktop UAC negative acceptance in approved isolated VM/session, second display and owner-active soak (none performed)
5. process memory safety and dynamic CMD/PowerShell/WSLg/Terminal descendants tracked by protected OS-level ownership, not regex policy alone

No live user GUI/keyboard/mouse/desktop switching, UAC, VM, service change, Agent upgrade, production UI patch, blind #480 merge or main merge.
