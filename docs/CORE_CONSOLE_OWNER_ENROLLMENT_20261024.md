# CORE physical console: implementation and rollout

CORE physical console is a separate, time-unbounded **revocable** grant. FULL and
a stored CORE preference do not grant input by themselves. ROOT expiry is not used.

## Implemented path

1. Cloud pairing (`connect`) records the authenticated control-plane HTTPS origin
   in the Agent launcher. Explicit enrollment also accepts `--core-authority-url`.
   Existing local-only tokens cannot impersonate paired cloud device credentials.
2. Owner CORE enablement queues a local enrollment request. The Windows Agent
   verifies current owner/device state and matching authenticated Broker health,
   then displays a real local Yes/No dialog (default No). `mode: core` on the
   console-request tool also requests enrollment; a valid existing grant is reused.
3. After local consent, re-read current authority. Generate an Ed25519 key and
   signed certificate bound to owner, device, installation and all three epochs.
   Seal the private profile with purpose-bound **CurrentUser DPAPI**, under a
   dedicated owner/SYSTEM/Administrators ACL. No caller supplies a key or pin.
4. Register the enrollment in independent D1 state. Every native input request
   rechecks it, reserves an externally durable one-use ID, atomically claims only
   the current enabled generation, then runs the typed native actuator. Local
   backup restoration cannot reset server generations or operation tombstones.
5. The local non-focusing tray monitor supplies desktop status and a **KAPAT**
   action. STOP writes a persistent marker immediately; native input checks it
   before each key-down/mouse effect. Renewed local consent drains old native work
   before clearing STOP. Lost ACK is UNKNOWN and never blindly replayed.
6. The physical actuator runs only at Medium integrity, on WinSta0/Default. It
   checks target session, PID/creation identity and foreground, holds process
   handles, and refuses elevated targets. Parent Agent death, native deadline,
   STOP/BLOCKED, lock or Secure Desktop stops further input. Key releases are
   permitted for cleanup. UAC, administrator permissions and private AI routing
   are not bypassed. The HIGH Broker is queried for health, not used for input.

## Authority and revocation

Migration `0019_core_console_authority.sql` adds generation/revoke rows, status,
nonce replay protection and durable operation tombstones. Triggers invalidate
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

Apply migration 0019 **before** deploying the Worker that instantiates
`D1CoreConsoleAuthority`. Deploy a matching Agent/Broker package afterwards.
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
