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

## Remaining before installation

Reviewed opt-in self-contained runtime/installer and rollback; independent
authority v2 challenge issuance and current revocation/restore custody; Agent
adapter and #982 mTLS/verifier composition; real machine-key ACL/TPM/SCM/pipe
acceptance (including hostile owner clients); two-device visible enrollment,
reboot, reconnect, interruption and offline revoke testing. Local service source
compilation/CNG diagnostics must pass before presenting any installation UAC.
