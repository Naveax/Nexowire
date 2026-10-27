# CORE physical console: implementation and rollout

## SECURITY HOLD (2026-10-27, #04 / #911)

**Production default: LOCAL_ENROLLMENT_REQUIRED / CORE.active=false.**
The former Agent-spawned Windows Forms Yes/No prompt, device-signed
`approvedLocallyAtMs` and D1/SQLite fixture are **not** independently
attested human physical consent. The JavaScript prompt fallback has been
removed. Old DPAPI-signed certificates with no independent native session
readback no longer authorize physical input.

Before enabling enrollment, a genuinely protected native Windows component
must (1) bind owner account + device + installation + current owner/revoke
generations and a unique challenge to the real WinSta0/Default human approval;
(2) bind that approval to the active Windows logon LUID and session;
(3) atomically consume a one-shot receipt in an independently protected,
rollback-resistant ledger; (4) provide fresh OS-readback on every admission,
rejecting logoff/session swaps and replay; (5) be authenticated by the D1
enrollment verifier, not merely by the Agent's own Ed25519 key/JSON payload.
The current production composition roots install **neither** a native approval
provider nor the independent server-side verifier. The default D1
`enroll` endpoint therefore rejects even a correctly device-signed request.
A source-only synthetic adapter is used solely inside regression tests. It
cannot attest real Windows approval.

Physical operator step **after** a trusted native component and signed Broker
have been installed and independently verified: at each Windows PC's
unlocked **local** default desktop, initiate a fresh owner-bound CORE enrollment,
inspect owner/device/session details and accept the protected native prompt.
Verify one-use consumption, independent readback and STOP/revoke on each device.
Until those prerequisites exist, do not attempt to simulate approval or
reclassify online Agent / stored preference / UI checkbox as active CORE.

CORE physical console is a separate, time-unbounded **revocable** grant. FULL and
a stored CORE preference do not grant input by themselves. ROOT expiry is not used.

## Source contract (protected native provider not installed)

1. Cloud pairing (`connect`) records the authenticated control-plane HTTPS origin
   in the Agent launcher. Explicit enrollment also accepts `--core-authority-url`.
   Existing local-only tokens cannot impersonate paired cloud device credentials.
2. Owner CORE enablement may queue a local enrollment request, but the current
   production composition root has no protected native approval provider. The
   Agent therefore shows no approval dialog and keeps
   `LOCAL_ENROLLMENT_REQUIRED`; a JavaScript Yes/No result is not accepted.
3. A future protected native provider must bind each one-use receipt to owner,
   device, installation, authority epochs, a separately provisioned Windows user
   SID, WTS session ID, token `AuthenticationId` LUID and a per-logon session
   epoch. D1 persists that exact binding and an independent verifier checks it
   against the current OS logon on every status/admission. Only then can an
   enrollment key and certificate be registered.
4. Once an independently verified native receipt exists, D1 stores the receipt
   ID and exact owner SID/session ID/AuthenticationId/session epoch. At `claim`,
   D1 consumes the operation ID before async OS readback and makes any stale or
   UNKNOWN attempt terminal. The Agent repeats readback after claim and before its
   actuator call. Native Windows code still needs its own final logon/target check.
   The production verifier is absent.
5. The native input source path uses a local STOP marker, typed actuator inputs,
   target/session checks and no blind replay after UNKNOWN. These source checks
   do not establish the missing physical enrollment provider.
6. The source actuator is constrained to Medium integrity and WinSta0/Default;
   it checks target session, PID/creation identity and foreground and refuses
   elevated targets. UAC and administrator permissions are not bypassed. These
   are source/CI properties, not physical acceptance of the installed Broker.

## Authority and revocation

Migration `0019_core_console_authority.sql` adds generation/revoke rows, status,
nonce replay protection and durable operation tombstones. Migration
`0020_core_console_native_logon_binding.sql` stores the native receipt and exact
Windows owner/logon binding. A trigger clears it on owner, enrollment or epoch
invalidation. Other triggers invalidate
records on CORE OFF, SAFE, bridge OFF, credential/owner change and preference
removal. New admission after OFF is synchronously denied by the D1 claim CAS.
Already admitted input is cancelled through the local marker/watch path: authority
is polled every two seconds, with bounded network timeouts. This is not a claim
of zero-latency distributed cancellation or atomicity between D1 and Windows.
Local STOP does not wait for the network. Unconfirmed external revocation remains
persisted as pending and is retried before granting access after restart.

Status separates preference, local enrollment and effective physical control.
The dashboard labels **physical** access separately; it never calls this Windows
administrator/HIGH verification. Signed status older than 15 seconds is inactive.
Normal 1–60 minute local grants remain separate. A saved local consent with no
current native status returns `localDecisionApproved` separately from `approved`.

## Required deployment configuration

Apply migrations 0019 and 0020 **before** deploying the Worker that instantiates
`D1CoreConsoleAuthority`. The current build still has no production native
consent provider or independent D1 verifier; migration alone cannot enable
enrollment. Deploy a matching Agent/Broker package afterwards.
New cloud `connect` enrollment persists the correct authority automatically.
Existing paired Agents need the same trusted origin in
`NEXOWIRE_CORE_AUTHORITY_URL`. No remote tool payload can select another origin.
No profile, missing configuration, corrupt DPAPI data, absent current device
credential or verification outage leaves physical control inactive.
Profile bootstrap and DPAPI decryption are asynchronous; they do not hold up Agent
hello or heartbeat. Admission re-reads the bounded encrypted profile on every
check, reusing decryption only for identical ciphertext. Current authority and
STOP are never cached. Read-only/bootstrap Windows cold starts have a separate
timeout; the physical input worker retains its 25-second native deadline.

The key protects against other Windows accounts and at-rest tampering; it is not
an isolation boundary against malicious code already running as the Windows owner.
This feature does not provision a signed HIGH Broker, bypass UAC, or replace the
separate signed/protected installer acceptance gates.

## Validation and rollout status

Tests execute the real HTTP handler, Ed25519 verification and D1 SQL using an
isolated SQLite database, including restart, old backup restore after OFF/ON,
wrong owner/credential/issuer, parallel reservation, revoke-before-claim and lost
native ACK. Native callbacks and local decisions in these integration tests are
explicit fixtures, not physical control acceptance.

Separate Windows tests compile and execute the real Win32 guard (read-only probe),
exercise real DPAPI save/reload/tamper rejection, and preserve all installed Agent
state. A staging source patch passed these tests on Naveax without injecting input.

This change is not a production rollout. Worker migration/deployment, a published
Agent update, real human first consent, actual input/STOP validation and independent
checks on both installed PCs must precede a claim that live CORE control works.
