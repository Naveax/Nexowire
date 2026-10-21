# Nexowire #09: local emergency cancellation and private helper preflight

**Parent:** #728 exact HEAD `52d13f4327094196ee882cbec50806cd7db6ea60`, CI #39659941037 **7/7 SUCCESS**. No live Windows GUI, user input, VM, UAC or service changes.

## Real source findings and corrections

1. **Viewer local STOP race.** Before this revision `windows-private-viewer.ts:handleLocalEmergencyStop` queried `windows.private_desktop.status` and required `inputDesktop === Default` *before* calling `stop`. If that query failed, returned unknown, or observed Winlogon, the durable cancellation fence was **never written**. The actual local STOP handler now calls exported `requestPrivateDesktopEmergencyStopFence()` first. A subsequent status/UI problem may correctly report `AI stop not completed`, but it cannot leave future private GUI/child/input requests enabled. The pending marker is not evidence the process stopped.

2. **Private input helper after dispatcher check.** The previous `privateInputRequest` awaited request-file write and SHA-256 helper identity checks between the outer dispatcher cancellation check and creation of a private input helper. It could initiate work after the user pressed STOP. It now checks the marker before request setup **and again after helper integrity validation**. As this input worker is another OS process whose old cleanup used PID-only taskkill, it also requires the unavailable protected #03 owner witness before launch. No new uncontrolled helper process is started in this branch.

3. **Startup host loophole.** Parent #728 failed closed for regular `launchApp`, but `start()` still launched a new private desktop host and PowerShell shell using user-writable scripts without native Job ownership. The startup entry now requires a protected owner before `ensureScripts` or any `spawn`; the underlying `request('launch',...)` additionally enforces owner witness and cancellation. No runtime source can use a caller-provided signed/CORE JSON claim to bypass that boundary.

## Scope of validation

Read-only code inspection plus disposable generated-TEMP fake `state.json` tests exercise the actual dispatcher and local emergency-fence API. The viewer ordering is tested by source inspection; no physical viewer was clicked. No native private host, ShellExecute, COM, file-picker confirmation, physical keyboard, pointer or UAC transition was initiated.

- New focused Windows tests `test/private-desktop-runtime-owner-failclosed.test.ts`: local marker before malformed status; host start denies before writing helper files; worker source rejects stale marker after await; prior synthetic forged PID/child, corrupt state and marker substitution stay negative.
- Combined Work PC run: **102 cases, 100 PASS, 0 FAIL, 2 SKIP**. The two skipped tests are existing opt-in physical desktop fixtures, not disabled regression tests. Typecheck, build, and AI Screen launch audit PASS; direct spawn audit still 59 callsites / 45 signatures with preexisting indirect native/COM caveats. **New SHA GitHub CI must be checked independently.**
- Existing valid Guardian CORE/Broker *preapproved reserved-intent* positive test passed; no signed Broker publisher/ACL or production high-token authority claimed.

## Production NO-GO

The persistent emergency marker is **user-writable, not OS-protected**. It cannot stop an already in-flight native write atomically or terminate any existing private processes. The default protected native #03 collector is **still missing** from `windows-private-desktop.ts`, and `killTree(pid)` itself still contains raw PID-only taskkill (unreachable from this branch's unverified stop path). As a result **start, child launch, private input helper spawn, and actual stop remain fail-closed/unavailable by default**. This branch must NOT be merged into a production Agent until the #03 owner ships an atomic native Job/HANDLE+FILETIME-coupled lifecycle and real signed helper/trusted-publisher/parent-ACL acceptance.

Other BLOCKED: real owner-approved CORE elevated process lineage, dynamic renamed DLL/COM/WSL/Windows Terminal descendants, Explorer cross-PID file picker file-acceptance postcondition, actual Winlogon Secure Desktop negative acceptance, and owner-active dual-display soak. No Secure Desktop UAC automation. Old #480 overlap already main; no blind merge.

**Important:** extra cancellation checks narrow the race but do not create a kernel-atomic fence. Side effects already in progress remain UNKNOWN; never silently replay them. A signed trusted CORE Broker approval pathway remains independent and unchanged.
