# NEXOWIRE #09 runtime owner fail-close source acceptance (21 Oct 2026)

## Parent exact-head evidence

- #692 `e8d44653fdb4175565a24facd17381fca18ed514`: GitHub run **#39644955345 SUCCESS, seven of seven jobs**. Parent #663 `508cc0870699b58d384f04fcb6b675a4dfac0a87`: run #39631336087 overall FAILURE only because **macOS lifecycle CANCELLED**, all six others including actual Windows Job + owner PID/creationTime source tests SUCCESS.
- #03 protected kernel Job `verifyWindowsKernelJob(pid, creationFiletime, guardianPid, guardianJobHandle)` uses a duplicated unnamed Job HANDLE, `IsProcessInJob`, `GetProcessTimes`, breakaway and kill-on-close limits, but only on its ProcessManager pathway. It does NOT bind `windows-private-desktop.ts`'s user-writable `state.json`, raw launched PIDs, native command provenance, or ownership epochs.
- Protected Broker signed publisher, protected imports/parent ACL, and native CORE elevation remain a separate authority. This branch neither edits that authority nor treats private desktop GUI automation as elevation.

## New source code (DRAFT, intentionally fail-closed)

`src/agent/private-desktop-runtime-owner-gate.ts`: explicit protected owner-mutation gate, with **no default collector**. Current runtime supplies no trusted kernel witness, so child launch/stop requests return `PRIVATE_DESKTOP_OWNER_WITNESS_UNAVAILABLE`. The two-read verified process/Job contract has an extension point for the future #03 *trusted native* collector, but arbitrary RPC/environment/self-reported JSON cannot enable it. Positive synthetic witness returns inert frozen `pid + creationTime` only, not native action permission.

`src/agent/windows-private-desktop.ts` now actually calls this gate BEFORE `launch(...)` and BEFORE any PID-only `taskkill(...)`/host kill in `stop()`. This prevents forged child-launch PID receipts and user-writable state PIDs from authorizing real OS actions. It does **not** claim an OS kernel Job owner is integrated.

A private-desktop `stop()` request persists `emergency-stop.pending` with an exclusive-create file and `fsync` before attempting trusted termination. Existing safe marker is idempotent; an unsafe replacement file type/reparse link rejects without following or writing to it. All subsequent private desktop capabilities except read-only status and stop reject while the cancellation marker exists, including GUI click, edit, keyboard, pointer, reopen/start and new child launch. If status/stop cannot complete, caller gets an error, not a forged stopped=true receipt. Neither a user-writable marker nor a source-only test is a kernel Job authority.

## Independent bounded tests

`test/private-desktop-runtime-owner-failclosed.test.ts`: disposable **temporary state.json only**, with inert synthetic PIDs and no created private desktop, GUI, UAC, mouse/keyboard, process kill, VM or live service. Actual `executeWindowsPrivateDesktopCapability` code must:
1. Write emergency cancellation marker before aborting unverified PID-only stop, preserve original state and reject duplicate stop; no synthetic success.
2. Fail every new GUI/child/input/click/close/start when stop is pending.
3. Reject forged stored `launchedPids` and untrusted `CORE`, highToken, signedPublisher JSON before native launch.
4. Reject an unsafe pre-existing marker directory/reparse substitution before any process action.
5. Preserve the separate verified parent source-contract positive fixture but never grant native GUI, UAC or stop rights from JSON booleans.

Hosted Windows CI always runs these tests as a dedicated step. They are source-level/temporary filesystem acceptance, not proof of true Job kill-on-close, process handle identity, or unmodified user-active desktop behavior.

## Remaining physical gates: NO-GO

- There is **no #03 authenticated OS Job/HANDLE collector wired into this private runtime**. Therefore launch and stop become unavailable on this branch until approved integration. **Do not merge to production** as an end-user feature release. A pending emergency stop blocks new operations but cannot by itself prove or perform native process termination, so it is not physical emergency-stop acceptance.
- Guarding one callback with a file marker is not an atomic OS cancellation of already in-flight GUI input, nor a protected/immutable marker; a local attacker who can edit the runtime dir can tamper. The absence of a kernel Job prevents end-to-end containment.
- Trusted signed CORE Broker preapproval stays separate, untouched and permitted by its own policy when physically installed and verified. No UAC Secure Desktop scripting, COM/Explorer cross-process file picker click, Default focus/mouse/keyboard or VM performed.
- Private child COM/WSLg/Terminal native indirect descendants, signed helper publisher/parent ACL, real Explorer file acceptance and current owner-active multi-display soak are still BLOCKED. A writable JSON/witness can never substitute for protected kernel evidence.

#480 old broker patch is already equivalent in main; not merged. #03 owner responsible for native process handle and Job lifecycle, #09 solely source guard and tests. Exact CI must be checked on this new SHA, not inherited from #692.

## Corrupt-state and marker-replacement source hardening

The emergency-stop marker now uses an exclusive-create (`wx`) file, rather than append to an existing path; a pre-existing directory, symlink or other non-regular marker is rejected. This avoids following an attacker-selected marker target. `stop()` records the cancellation marker **before parsing** persisted state, so malformed `state.json` cannot accidentally reopen GUI or keyboard dispatch. The additional no-GUI/no-VM test uses an invalid JSON state and verifies the marker persists while keyboard dispatch is refused. This is still a writable local marker, not kernel-backed revocation or atomic cancellation of an already running GUI request.
