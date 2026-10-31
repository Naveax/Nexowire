# Opt-in local enrollment service (in development)

This source is not installed by the normal Nexowire bundle. It does not activate
CORE and is not ready for a live installation. It requires .NET 10 Windows.

Implemented: native SCM lifecycle; protected CNG machine key and immutable signed
v2 enrollment store; explicit elevated same-owner consent/revoke dialogs;
local-only owner-authenticated named pipe; fresh kernel token SID/session/LUID
and active physical-console readback; signing only an independently signed,
scope-bound, expiring authority challenge; durable one-use nonce claims before
signing; bounded minimal-rights native client; cross-language CNG diagnostic.

`bootId` is a protected service-incarnation UUID, renewed on every service start
(and therefore reboot). It is not represented as the Windows kernel boot UUID.
The durable grant is unchanged when this incarnation rotates.

The status response is untrusted until its grant signature matches an independently
provisioned pin. Status alone never admits a command. Attestation requires the
separately provisioned authority key; no test key is installed by this component.
The authority challenge signature domain differs from the device witness domain.
After lost acknowledgement, query/reconcile at the independent authority rather
than retrying a consumed nonce. The local claim ledger fails closed at 100000
entries; maintenance/compaction with independent authority acceptance is still
needed before this is suitable for long-running production.

TPM is requested explicitly; failure never silently falls back to software.
Software CNG is available only through the explicitly selected software mode.
The service claims neither TPM attestation nor local rollback resistance from
software keys, signatures or filesystem ACLs. Independent current revoke state
is required for remote admission. Local revoke persists before success, and the
service checks it again before returning a witness. Existing native execution
revocation/admission checks must still run.

The elevated enrollment dialog is a real visible user action. It has no `--yes`
switch and rejects another administrator's SID. Do not simulate its button or
count a service diagnostic as approval. A partially written enrollment is left
blocked for explicit recovery; it is never overwritten automatically.

## Diagnostic build

```powershell
dotnet build native/windows-local-enrollment/Nexowire.LocalEnrollment.csproj -c Release -o native/windows-local-enrollment/bin/qa
node --test --import tsx test/windows-local-enrollment-native.test.ts
```

`--self-test` creates and deletes a disposable CURRENT USER software CNG key,
verifies that private export is rejected, and prints public signed test vectors.
It does not touch the protected enrollment store, SCM, Agent or human approval.
`--machine-key-self-test` additionally requires an elevated diagnostic process;
it creates/reopens/deletes a disposable machine software CNG key and checks its
SYSTEM/Administrators owner/DACL plus private-export denial. It creates no grant
or service and is not counted as human or hardware enrollment evidence.

## Remaining before installation

The opt-in build/install scripts under `scripts/local-enrollment` are pending
Windows acceptance. The build emits a self-contained runtime and SHA256 manifest;
the installer requires an independently supplied manifest hash, explicit exactly
two-device allowlist, current Agent identity and same-owner request. Preflight is
read-only. Actual install uses Windows PowerShell 5.1 under normal local UAC,
copies/hash-checks protected runtime bytes, invokes the visible ceremony, then
creates an Automatic LocalSystem SCM service. It does not change the old Agent or
Broker and reports coreActivated=false. Partial failure preserves grant/key and
diagnostic evidence, removing only the exact new service it created. No such
installer has been run on the user's devices.

Independent
authority v2 challenge issuance and current revocation/restore custody; Agent
adapter and #982 mTLS/verifier composition; real machine-key ACL/TPM/SCM/pipe
acceptance (including hostile owner clients); two-device visible enrollment,
reboot, reconnect, interruption and offline revoke testing. Local service source
compilation/CNG diagnostics must pass before presenting any installation UAC.

## AI-02 hardening candidate (Draft only)

The native pipe now sends a bounded, non-sensitive v2 denial frame for rejected
operations when the client remains connected. The diagnostic client refuses
denials, wrong protocol versions and frames that claim dispatch permission.
It still does **not** cryptographically validate raw pipe output: only an
independently pinned Agent verifier may use signed proof, and no proof activates
CORE by itself. A consumed challenge nonce cannot be replayed after a lost ACK.

The opt-in installer preflight additionally requires that the **device UUID,
installation UUID and owner account ID** match the independently supplied Agent
identity. Incomplete identity fields fail closed. This comparison does **not**
authenticate that identity file's provenance. The coordinator must supply
an independently protected and authenticated Agent identity export before
installation acceptance; simply copying matching attacker-controlled JSON
is insufficient. The current installer is not approved for production.

The read-only opt-in service-removal preflight is:

```powershell
.\scripts\local-enrollment\uninstall.ps1 -ExpectedManifestSha256 '<pinned-sha256>' -ExpectedDeviceId '<device-uuid>'
```

Actual SCM removal requires `-Execute`, a local elevated interactive console,
the installed service's exact path and device match, a previously committed
local `revoked.json` marker and a typed, device-specific operator confirmation.
It removes only the service registration, preserving runtime files, CNG keys,
nonce history and revocation evidence for manual review. It does **not** remove
the original Agent/Broker, reinstate revoked grants, reset state or assert
successful final SCM deletion while Windows may still be finalizing it.
Run only in an authorized disposable Windows test environment until accepted.

The targeted Windows CI tests exercise CNG diagnostics, strict response-frame
validation and disposable read-only installer/uninstaller preflights. They do
not prove actual hostile-client IPC containment, service crash recovery,
installer rollback, TPM trust, unattended reboot operation or two-PC acceptance.

## AI-02 physical-console ceremony fence (Draft only)

The elevated enrollment/revocation UI now requires a live *active local console*
Windows session. The native WTS console session ID, client protocol type (0 =
local), and connect state (active) must agree, and the console session ID is
rechecked after each WTS read. Enrollment checks immediately before displaying
and again after the user confirms; switching to RDP or disconnecting during the
ceremony rejects the grant before protected storage is written. The service
reuses the same native checks for client attestation. Synthetic snapshot policy
tests are **not physical approval** and do not activate CORE.

The diagnostic `--attest` client additionally refuses a success frame with a
missing or null witness. The `--status` client refuses an unexpected witness
object. This is strict response framing only; cryptographic verification and
fresh independent issuer/revocation state remain external requirements.

## AI-02 local revoke/attestation serialization fence (Draft only)

Attestation now holds an exclusive kernel file-share handle in the protected
ProgramData root through its response. Visible local revocation acquires the
same fence after confirmation, revalidates the signed grant under the fence and
persists the revoke marker before reporting completion. A crash drops the kernel
handle; an existing marker still blocks startup/signing. Lock acquisition is
bounded by a monotonic clock and cancellation and **never** treats contention
as approval. The diagnostic self-test proves only Windows temp-file exclusion,
timeout/cancellation and reopening, not real SCM crash/restart or actual owner
revocation. A response already delivered before revocation is still subject to
independent verifier expiry and current external revoke checks.

## AI-02 status / attest final admission fence

Both local IPC operations now acquire the same protected revoke/attestation
file-sharing fence before loading current signed grant state; status is still
read-only and `mayDispatch=false`. For attest, the native service rechecks
live console SID/session/LUID, unchanged protected grant/revocation state,
challenge TTL and cancellation **after signing, immediately before sending**.
Both success replies must fit the bounded 16384-byte protocol frame. A stale
session or expired challenge fails closed, while any already consumed nonce
remains consumed after a lost ACK. This is source-side narrowing of a race, not
an atomic OS-to-remote-dispatch guarantee: AI-03 must independently enforce
current external revoke/generation/one-use admission at the last execution
boundary. Synthetic self-test exercises late-expiry and changed-session
rejections; it is not an installed Windows Service or physical consent test.

## AI-02 exclusive fence ACL handle readback

The local revoke/IPC lock file uses `FileShare.None`; opening its path a
second time to read the ACL can produce an OS sharing violation. The protected
owner/DACL check now reads from the **same already-open exclusive FileStream**,
while checking bounded file size and absence of reparse attributes, and retains
all original fail-closed SYSTEM/Administrators-only ACL requirements. A new
Windows disposable self-test reads ACL on an exclusive handle and verifies
contended second open fails by timeout. This is not proof of production SCM
hosting or an enrolled owner; real installed service tests remain outstanding.

## AI-02 strict diagnostic response field set

The native `--status` and `--attest` clients now reject duplicate JSON
properties at any depth, unknown or missing top-level v2 keys, unsupported
key-provider strings, empty public-key encoding and incorrect witness shape.
Both success envelopes must declare `mayDispatch:false` and are **still
untrusted until independently cryptographically verified and pinned**.
Disposable self-tests retain positive status/attest controls and explicit
negative malformed/duplicate/downgrade cases; no enrollment or SCM actions.

## AI-02 disposable negative: protected-record parser and service principal

The native self-test now feeds empty, invalid UTF-8, overlong, duplicate,
unknown, missing-required and truncated protected-store wire records to the
bounded strict JSON reader. These must all reject and never be treated as a
restored enrollment. An independent runner test calls the *uninstalled*
`--service` entry as a non-LocalSystem principal and verifies it exits with
a generic denial, without calling SCM or modifying any service, ACL, key or
owner data. These **do not** test a real installed service restart/recovery;
independent disposable SCM acceptance is still mandatory.

## AI-02 local consent issuer visibility

The visible owner approval now displays the **exact installation UUID, owner
account ID, Windows SID, device UUID and the independently supplied authority
public-key SHA-256**, alongside TPM/software protection mode. Incoming P-256
authority SPKI is bounded, requires canonical base64, full DER consumption and
canonical re-export before a fingerprint is shown or persisted. Disposable
native tests reject noncanonical base64, malformed/truncated DER and wrong
curve; no consent UI is actually opened by the test. Showing a fingerprint
does **not** establish a trusted externally pinned issuer, grant generation,
current remote revoke, or Agent binary provenance. Those remain NO-GO gates.

## AI-02 final owner/console checks before persistent writes

Visible local revocation identifies the **device, installation, owner SID and
account, enrollment ID, and generation** being revoked. The code rechecks the
elevated owner and active console **after** any wait for the exclusive
revoke/attestation fence and immediately before validating unchanged protected
state and writing the irrevocable marker. Initial enrollment similarly rechecks
owner, admin rights and active local console after visible consent and **again
after TPM/software CNG key creation, immediately before protected config/grant
writes**. If the console changes during the key-creation window, partial
protected state is intentionally left fail-closed for reviewed recovery rather
than silently reusing consent. Native self-test validates the displayed scope
and invalid-grant denial without displaying any UI. This does not prove a live
SCM service or physical owner acceptance on production devices.

## AI-02 canonical authority recheck on protected store reads

On every `ProtectedStore.Load`, the stored external authority public-key
SPKI must again satisfy the same bounded canonical P-256 DER and base64
validation as the original local enrollment. A corrupted, truncated, padded
or syntactically wrong key cannot produce a successful local status or
attestation response. The disposable native self-test checks valid protected
config and invalid version/base64/whitespace configurations without touching
the real ProgramData store. **Important:** even a well-formed substituted
authority key is not independently trusted: signed installation identity,
externally pinned issuer and monotonic off-device revocation remain separate
production P0 blockers.

## AI-02 reject self-inconsistent native IPC success

A client-facing native pipe response marked `verified:true` must now carry
a structurally valid and **cryptographically self-consistent** P-256 signed
grant. Its supplied canonical public key must hash to the grant's issuer
SPKI fingerprint; the signature must verify over the fixed domain-separated
grant bytes. Status requires bounded, valid native service incarnation/SID/
session/LUID evidence. Attestation additionally requires a signed matching
witness (owner, OS session, incarnation, LUID, grant hash, consent time),
with a final unexpired time check immediately before output.

This deliberately does **not** turn a self-signed, internally consistent
but unpinned pipe response into a trusted device or permission. Hostile
same-owner caller/process identity and trusted installed public-key pin,
external monotonic revocation/current generation and one-use CAS are still
independent authorization prerequisites. `mayDispatch` remains `false`.
Disposable positive and negative native tests exercise valid EC signatures
plus mutation, fake key, nested duplicate and tampered witness cases with no
SCM, UAC, enrollment or protected-store writes.

## Bind native attestation reply to the current submitted authority challenge

The client now retains the **exact signed authority-challenge payload sent over
IPC** and refuses a signed witness unless every session field matches that
specific payload, including the one-use nonce, owner SID, boot/service
incarnation, Windows session, logon LUID, and timestamp. Even a validly
device-signed *old or different* witness may not satisfy a new request. The
client still requires self-contained signatures and rejects expired/future
witness output, while `mayDispatch=false` is unchanged.

The standalone parser's negative tests include altered nonce, boot ID,
Windows session, logon LUID and absent challenge context. This remains
necessary defense in depth, **not** authority: neither the local client nor
its tests establish the externally pinned issuer, signed installed Agent
identity, current generation/revoke or durable remote one-use CAS.
