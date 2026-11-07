# Personal functional recovery — 6 November 2026

## Result verified on NAVEAX

The installed 1.0.8 localfix Agent now uses an explicitly selected `local-owner`
CORE profile. The actual Windows owner approved one native Windows dialog.
A separate process read the saved CurrentUser DPAPI grant successfully, then the
running Agent was replaced and reconnected without another approval.

The first Scheduled Task restart did **not** replace the real Agent: the old
standalone PID 17008 survived while the task returned to Ready. This was detected
from process identity rather than accepted as success. A separate owner task
then stopped that exact verified executable and started the registered Agent;
the readback reported old PID absent and new PID 11560. Temporary tasks were removed.
There was no Windows reboot and no change to the existing Agent journal or Hub data.

First-party `windows.console_control.status` after the replacement returned:

```json
{"active":true,"grantId":null,"expiresAt":null,"remainingMs":null,"mode":"core",
 "core":{"preferenceEnabled":true,"localEnrolled":true,"active":true,
 "duration":"indefinite-revocable","expiresAt":null,"state":"ACTIVE_LOCAL_OWNER"}}
```

A first-party `windows.window.focus` call on the already active window then
returned `effectAttempted=true`, `guardVerified=true`, `nativeEffectVerified=true`.
This exercises the actual Agent execution path without a timed grant.

## Product behavior

`NEXOWIRE_CORE_APPROVAL_MODE=local-owner` selects owner-approved physical control
without an independent native approval service or off-host consent signer. The
existing protected-native mode is unchanged. Local-owner mode is explicitly
different assurance: it is not an independent native attestation or a Windows
administrator/UAC token. Existing authenticated ownership, FULL mode, owner/revoke
epochs and authenticated Broker health are read before execution. Consent has
no timer and persists under the same Windows user across Agent restarts.

`core-console status|enroll|revoke` is the local CLI entry point. The Agent's
launcher must persist the same approval-mode choice. Revocation writes a local
STOP marker. A later reenrollment requires a fresh local decision. Native input
uses the existing Windows target/desktop executor; arbitrary shell is outside
this physical-console profile.

Installed NAVEAX hotfix, with backups retained:

- Version: `1.0.8-localfix-4d699b8`.
- Added compiled `dist/src/agent/local-owner-core-console.js`.
- Composed it into the installed `windows-core-console-provider.js` factory.
- Updated provider SHA256: `F79D75158DB896C5F1E2C8163A9795AB963AB18C0C9903C9837FD2FE67010BF7`.
- Provider backup suffix: `.before-local-owner-20261106`.
- Launcher backup: `launch.ps1.before-local-owner-20261106`.
- This is a targeted personal hotfix, not a signed release or deployment of the
  full strict-CAS integration branch.

## Other fixes in source

1. Device-scoped `agent_operation_status` no longer requires an operator role.
   The ordinary target-device authorization and explicit tool allowlists remain.
2. Exact private desktop/window/viewer and virtual-pointer status metadata tools
   use ordinary usage pricing; inspection no longer requires a screen entitlement.
   This source policy change has not been deployed to the hosted MCP service.
3. A durable worker that publishes only `starting` until startup times out is no
   longer advertised as a running command. This reproduced on the installed
   NAVEAX worker with null child PID and zero events. Its exact worker was stopped
   after confirming no child existed; it was not blindly replayed. The source
   regression test uses a real disposable worker that remains in starting state.

## Verified boundaries and remaining work

| Item | Current evidence / remaining work |
|---|---|
| NAVEAX permanent CORE | Live local consent, restart reuse and native focus PASS |
| Windows reboot retention | DPAPI persistence tested across processes; actual OS reboot NOT_RUN |
| Work-PC Broker mode | Launcher changed and Broker authenticated READY in preceding work |
| Work-PC permanent CORE | NOT_COMPLETE; latest preferenceEnabled=false, localEnrolled=false |
| Generic elevated shell / Hyper-V | NOT_IMPLEMENTED; existing typed Broker does not elevate shell.exec |
| Unknown-operation owner lookup | Source change and Agent journal status tests PASS; hosted tool refresh/deployment pending |
| Private desktop 403 metadata | Source quote fixed and tested; hosted deployment pending |
| Durable Windows worker hang | Personal local-owner mode uses ordinary user spawning; live PID/stdout/exit 0 PASS. Optional Job guardian hang is not claimed fixed for other profiles |
| Work-PC SQLite cutover | Hub restarted, live CLI resolves to existing idempotency-sqlite-hotfix package; SQLite/no fixed capacity and health 200 verified, 2008 rows / 4 unknown retained |
| NAVEAX standalone Hub | Installed, autostart enabled, loopback health 200; 80 legacy rows migrated; SQLite writer PID and listener PID both 12048; quick_check=ok |
| Cloudflare external ingress | Existing #1090 source; no new tunnel deployment here |
| CAS production composition | NOT_CHANGED; do not claim shell/write acceptance for the new integration runtime |
| Update/rollback | #1092 remains separate; no OS reboot/rollback acceptance performed here |
| Orchestrator / LiveBridge | Not deployed or enabled by this CORE change; old provider attempts untouched |

No row above should be inferred complete from a source test, local hotfix or
another PR's green CI. Current feature work is prioritized over adding new gates.

## Hub live acceptance details

Work-PC originally listened under PID 15272. An owner task backed up JSON and
SQLite using the SQLite backup API, retained the original module with suffix
`.before-sqlite-20261106`, and replaced the original version module with the
SQLite reader (SHA256 `E841E43A426CD984BFB054F11901265A602FB21469B7808A2ADC0C22B338C624`).
After restarting the Hub, listener PID 18804 actually used the separate
`1.0.8-a19a228dc6f1-idempotency-sqlite-hotfix` CLI selected by its preexisting
launcher. Its active idempotency module SHA256 was
`05799241077FC9E72141916BBCFE5C5A04C0E650F0D7A90F071E5AC4DA303015`;
it imports node:sqlite and has no default 2000/5000 cap. That deployed variant
has no hub_writer metadata: an attempted newer-writer-PID assertion failed and
was not treated as acceptance. Live quick_check, preserved row counts, actual
package identity and HTTP 200 were checked instead. The temporary cutover task
was removed. Do not silently overwrite the separate hotfix package.

NAVEAX received the same SQLite module in the installed localfix package and
its existing `hub install` CLI registered a user-logon `Nexowire Hub` task.
State directory remains the existing `.nexowire/hub`, host 127.0.0.1, port 43110.
The 80-row JSON file and module were backed up before initialization.
The new database has 80 rows, 0 unknown, quick_check=ok, and its hub_writer PID
12048 matches the listening process. No production provider messages were sent.

A first disposable Windows SQLite test incorrectly counted `store.list(10000)`
as a complete inventory; that API caps displayed results at 500. The test was
corrected to query SQL COUNT, not by deleting records or changing a storage cap.
The corrected test retained all 2008 source rows and four UNKNOWN rows, inserted
a disposable 2009th reservation, and passed. Live data was untouched by this test.

## Personal process availability

The explicit local-owner profile selects ordinary user processes for headless
process sessions rather than requiring the optional Windows Job guardian.
This is best-effort process-tree cleanup, not Job containment or automatic
crash-time child reaping. The private-desktop path and Windows token privilege
are unchanged. Default/native profiles still select the Job guardian.

On NAVEAX the installed process-worker received a backed-up one-condition
hotfix (SHA256 `4E149117DE72310B1F6B10CF0DD0B3A7FCBD8580AFFDFD665835069E0E75FD3C`).
A real durable command returned PID 11728, stdout NAVEAX_PERSONAL_DURABLE_OK,
terminal exited and exitCode 0 through the first-party process APIs.
The earlier stalled worker remained starting with no child PID; its exact
identity was checked and stopped before this independent acceptance command.

A second live acceptance started a 120-second shell, read its READY output,
then stopped it through process.stop. It returned terminal exited (exitCode 1
from requested termination); root PID 19444 ended. Tree cleanup remained
reported unconfirmed, consistent with the documented best-effort mode.

The installed NAVEAX process-manager also received the personal-mode launch
condition and starting-state validation, with a backup retained. Its updated
SHA256 is `4CD4EAD0E87CDB9808A2D8427CEAA3F4D6171EDF4A77FC04D68DEA8BD2C89503`.
After a second verified Agent replacement (PID 11560 -> 2960), CORE remained
active with no expiry or new consent. A default non-durable process returned
PID 3552, stdout NAVEAX_PERSONAL_DEFAULT_OK and terminal exitCode 0.
Agent, Broker and standalone Hub tasks all remained Running. Temporary
activation tasks were removed.

The hosted control-plane dashboard's independent-native enrollment telemetry
is not updated by local-owner mode. The actual first-party device console
status and effect readback above are the evidence for this personal mode;
do not represent its grant as an independent native/cloud attestation.
