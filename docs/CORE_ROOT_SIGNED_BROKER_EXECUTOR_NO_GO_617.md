# #617 CORE/ROOT broad signed Broker executor: source contract, no live elevation

**Owner #03, child of PR #620. 21 October 2026.** No real privileged
execution, installation, UAC interaction, Hyper-V mutation or service change.

## Why this is not VM-only and not SAFE masquerading as CORE

Existing `shell.exec` runs with its actual Windows token. It **must not**
silently become elevated. A future protected, independently authenticated
**signed elevated Broker** may accept separately named commands:

- `core.shell.exec`: broad privileged shell command with structured
  executable + argv + optional workdir, not restricted to Hyper-V
- `core.process.start`: broad managed privileged process launch
- `core.process.stop`: privileged stop **only after verified PID +
  creation FILETIME + expected process-image digest**, no PID-only taskkill
- `hyperv.vm.status/start/stop`: distinct typed VMId operations, exact
  immutable canonical GUID grant, never free-form VM name

These capabilities appear as **request contract values**, not executable
API registrations. Nothing here is installed, started or elevated, and
`CORE_EXECUTOR_DISPATCH_ENABLED=false` unconditionally. Fully forged
positive predicates still return `ELEVATED_DISPATCH_NOT_INSTALLED`.

## First physical local UAC bootstrap, then no repeated UAC

An eventual owner-approved *physical Windows local interactive* installer,
NOT remotely pressing Secure Desktop buttons, would need to establish a
publisher-validated and ACL-protected high-token Broker **once**. It would
also enroll a device-bound, owner-signed grant with an external monotonic
owner epoch and revoke/rollback authority. CORE persists until explicit
revocation, owner transfer or broker uninstall; ROOT is separately
authorized for **at most 15 minutes**, with absolute expiry that cannot
be extended by sending more commands.

Every request must have fresh signed owner intent, an individually unique
request ID, short signed validity window, and a durable external
idempotency/CAS reservation. The already verified local bootstrap is not
a demand for an additional UAC dialog on every authorized CORE command.
But **preference is not effective privilege**: a UI checkbox, claimed
consent.exe presence, caller-provided `approved:true`, 401 response,
or unauthenticated Broker health check never proves elevation.

## OS trusted executable and process boundary

Required *independent Windows-native* evidence includes:

- Broker process integrity **High/System as authorized**, Administrators
  enabled rather than deny-only, and exact owner/device/epoch
- Authenticode publisher and signing certificate pinned to external
  release authority, signed installed and rollback manifests
- Running high-token process image matches the independently verified
  signed, protected image and version. Executable/import/parent/updater
  ACLs, ownership, reparse paths and rollback tree are protected.
- Process `PROCESS_DUP_HANDLE` boundary enforces real caller isolation;
  #576 demonstrates a medium-integrity same-user handle-retention attack.
- Trusted Hub pairing, local machine Broker authentication, owner-signed
  persistent CORE enrollment/revocation and a single strictly time-bounded
  ROOT activation. No replay or process PID-only successful cleanup.

A request can pass synthetic source policy while **no dispatch exists**.
The current `privileged-broker` capability allowlist and default Agent
`shell.exec` are intentionally unchanged. Nobody should wire broad
execution into that existing route without separate independent acceptance.

## UNKNOWN and postcondition

Loss of ACK **after possible mutation** is `UNKNOWN`, not failure or
success; no automatic replay. Require independent signed readback of
process identity, exit evidence, kernel Job membership, or exact
VMId and Running/Off state as appropriate. Durable externally-monotonic
owner-epoch / replay authority is not yet implemented here. A source
`requestAlreadyReserved` callback is a **testing seam**, not real CAS.

Any destructive `process.stop` must refuse a reused PID and distinguish
Job-membership-verified descendants from processes that may have
escaped through COM/UAC/WMI. In no circumstance does PID-only taskkill
provide verified tree-termination evidence.

## Exact CI red root cause and narrow fix

PR #620 HEAD `4ba879f591d19ddff3ca1e4cba0cf7ecc8a832b4`
CI `39604898508`: Windows Job fast-exit **PASS**. The Windows job failed
only in the two **new launcher trust tests**. One used a brittle
PowerShell `-Command` cert retrieval that returned exit code 1,
and the inherited-ACL test obtained null Windows ACL evidence.

The child modifies only the **isolated read-only** Hyper-V trust probe:
it now emits the actual OS Authenticode signer thumbprint from its
verified preflight JSON instead of separately spawning a brittle command,
uses `pwsh.exe` and native .NET Windows `FileSystemAclExtensions` for
ACL evidence, and preserves strict negative assertions. No skipping,
fake signed status or production approval.

## Blocking issues and release disposition

- #323 Admin Bridge actual device-side authenticated applied state / grant
- #271 legacy elevated writable ProgramData import and parent ACL
- #551 real first-party Authenticode installer, signed release AND rollback
  manifest, owner-controlled local physical UAC consent, staged VM canary
- #576 Job helper trusted publisher, protected image and lowpriv
  PROCESS_DUP_HANDLE boundary
- #617 real protected signed Broker bootstrap/enrollment/handler, externally
  monotonic owner epoch/ledger, high Windows token, authenticated
  process/Hyper-V readback and safe revoke
- #608 source integration green does not attest physical Broker rights.

**This child is design plus isolated negative tests only. Production NO-GO.
No real CORE executor or real Hyper-V operation was enabled.**
