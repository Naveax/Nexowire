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
