# NEXOWIRE #09: AI Screen / CORE Broker / Windows Job P0 acceptance, 21 October 2026

## Revision inventory

| Source | Exact HEAD | CI | Interpretation |
|---|---|---|---|
| #602 | `a55ef463e42a65506cfe2723d7fffdd03a17268e` | #39492809099 FAILED: Windows Job fast-exit stdout race, 6/7 other jobs PASS | Broker denylist source remains in DRAFT, not independently green |
| #611 | `ec2f0039e6b7f60d2a2f40d8934dfc6b380fe497` | #39597542588 FAILED: Windows hosted runner private desktop host NOT_READY, 6/7 other jobs PASS; release readiness #39597542524 SUCCESS | Combines #602 and #576, not a production Job integration |
| #576 at #611 parent | `91c69f66de88b755309e3c127f23357adcedfb86` | #39492594206 CI SUCCESS | Independent kernel Job proof on ProcessManager path |
| #576 current separate branch | `a3946c1f25b8ba151baf945b5acacc7aafbd66c3` | #39598258315 CI FAILED: native signed surrogate and inherited ACL/Modify tests; release readiness SUCCESS | This later HEAD is NOT incorporated here; #03 owner |
| #608 | `d34c0d3c85bc508be50c2e5f532aa964d8325106` | #39503650650 CI SUCCESS | Separate Job/MCP integration, not physical AI Screen acceptance |
| #480 | `ec3c54d77e3b9fabb4c85831222fb48b112cd7b2` | OPEN DRAFT; equivalent broker patch already main via #570 | Do not blind merge |

This is a **test-only follow-up** based on #611. No source modification to #03 Windows Job implementation or #602 broker policy. New CI test invokes synthetic source-only boundaries, not CreateDesktop/SetForegroundWindow/keyboard/mouse/UAC.

## Acceptance matrix

| Case | Source/Work PC test | Status |
|---|---|---|
| CORE/FULL owner preference | `reserveVerifiedGuardianCommand` with independently verified Guardian/owner/device/effective FULL facts reserves only an inert state, never process or GUI capability | Synthetic PASS |
| Missing signed/protected trust facts | Protected source, launcher ACL, canonical task, elevated effective token, pairing denied before reservation. Boolean facts are trusted only when collected by protected local Guardian, not remote self-report | Synthetic PASS for policy; actual Windows Authenticode signer chain **BLOCKED** |
| Trusted elevated Broker route | `windows-installer-job.ts` requires a protected, preapproved installer job, signed/hashed payload, and already elevated Broker. No `-Verb RunAs`/Secure Desktop click in private GUI dispatch | Source policy exists; actual CORE arbitrary elevated helper execution **BLOCKED** |
| Indirect COM/DLL/task/WMI/WSL/Terminal | `private-core-broker-boundary-negative.test.ts`, `private-desktop-additional-brokers.test.ts`, #602 regressions | Synthetic PASS for known literal forms only; arbitrary renamed/binary/dynamic child escapes **BLOCKED** |
| Unattended hosted Windows runner | Old #611 CI attempted CreateDesktop; `PRIVATE_DESKTOP_HOST_NOT_READY`. Replace routine CI portion with always-executed pure preflight checks. Real private desktop test only when `NEXOWIRE_PRIVATE_DESKTOP_PHYSICAL_ACCEPTANCE=1` in explicitly authorized isolated session | Source CI negative PASS; physical test **not executed** in routine CI |
| Actual private HWND/input desktop | Previous Work PC read-only physical `NexowirePrivate` vs `Default` observation, no focus change. Current turn does not alter Default | Prior bounded physical evidence, new user-active/2nd display soak **BLOCKED** |
| HWND/PID/session/grant | Existing #611 picker mutation tests reject stale or untracked PID and HWND, wrong session, duplicated semantic controls, replay | Synthetic PASS |
| Explorer cross-PID file picker | New private CORE test and #611 foreign PID negative; no fallback to physical input or arbitrary Explorer UIA | Synthetic PASS for fail-closed; real cross-PID selection completion **BLOCKED** |
| Secure Desktop/UAC | Inject Winlogon + emergency stop after grant; no UIA edit/invoke; private broker preflight rejects `runas` and `Start-Process -Verb RunAs` | Synthetic PASS; actual secure UAC not triggered |
| Job child provenance | #576 native unnamed kernel Job proof validates membership, creation FILETIME and limits, but only ProcessManager uses it | Isolated Job tests PASS for their own synthetic roots; private desktop Job adoption **BLOCKED** |
| PrivateDesktop `killTree(pid)` | Source test identifies PID-only `taskkill.exe /PID ... /T /F`, without OS HANDLE/creation time or Job proof | **BLOCKED**; no foreign/live PID killed |
| Helper trust | Script SHA-256 compare and #576 protected helper hash, with post-check TOCTOU and trusted publisher/ACL gap | Source PASS for byte tampering; signed protected immutable process lineage **BLOCKED** |
| Large file GUI transfer | Picker uses authorized existing local file path; #08 streaming ingest uses 65536-byte chunks and source limit 256MiB; no clipboard/DOM file blob | Contract known; end-to-end UI-to-streaming integration **BLOCKED** |

## CI failure root cause and non-conflation

- #602 failure was Windows Job fast-exit stdout drained after status `exited` at iteration 5, **not** broker test failure.
- #611 failure was unattended Windows CI runner's private desktop host startup not ready, *before* negative broker test. It does not prove an unexpected default-desktop click or physical session isolation failure. Do not treat GitHub runner as a real owner's interactive session.
- New hosted test always validates broker denials and signed-policy gates without private desktop creation. The prior physical test body is maintained as an explicit opt-in fixture, not reported as executed when the variable is absent. No tests are skipped or errors swallowed.
- #576 current head independently failed signed surrogate and inherited ACL tests. Do not infer #576 latest production trust acceptance from its older green head.

## Out-of-scope / production NO-GO

Do not deploy, merge to main, alter UAC, change the user's Default foreground, type keys, click mouse or open Explorer on the user's desktop. No UI control action was sent to physical process. Do not call #03 process.stop or generic `taskkill` on an unverified PID. File-picker grants must remain scoped to the trusted private HWND/PID/session/generation; UNKNOWN edit/invoke must never replay. Production acceptance requires an authorized isolated VM for real secure-desktop transitions, signed elevated Broker attestation and durable CORE revocation, kernel Job/HANDLE identity for all private descendants and stop, and independent long owner-active monitoring.
