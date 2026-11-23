# NX AI-03 | Broker JSON snapshot boundary | 2026-11-23

## Scope and provenance

- Base integration Draft #1160 exact SHA: `83c8b651106ecd1244fb9d982cf94fd390c15b6b`.
- Owned production file: `src/agent/privileged-broker-effect-admission.ts` (baseline blob `c38b91b732608f62381b2262829d13144ff1427e`).
- Owned regression file: `test/privileged-broker-effect-admission.test.ts` (baseline blob `eafdeb2b04b91d16723bbd358380b2590846b6b2`).
- This change is **source-only**. It does not enable `CORE_EXECUTOR_DISPATCH_ENABLED`, enroll an owner, change a production task, touch user SQLite, or install a Broker.

## Issue and defensive change

The previous pre-admission `JSON.stringify` of untrusted effect input and transport receipts executed user-defined getters and `toJSON()` hooks. The fingerprint and signed receipt had immutable copies, but JavaScript had already executed before the admission decision.

`snapshotPlainJson` uses own data descriptors and strict JSON-only object/array graphs; it refuses accessors, function values, sparse arrays, symbols, exotic prototypes, non-finite numbers and cyclic graphs. It preserves insertion order, uses a null-prototype copy, and deeply freezes copies. Both effect fingerprints and signature payloads now derive solely from those independent snapshots. Non-JSON input is denied **before external CAS**. Malicious receipt is denied without executing hooks or consuming signed response data.

This protects only the JavaScript marshaling boundary; it is **not** a Windows-native Broker, DPAPI or durable CAS proof. Reflective traps on hostile Proxy objects cannot be assumed side-effect-free; the external authority must consume separately authenticated transport JSON.

## Negative regressions

- Input getter, custom `toJSON`, sparse array, inherited property, undefined/symbol/non-finite value: DENY with no external begin and zero hooks executed.
- Reservation or commit with a getter: DENY without executing it or invoking effect.
- Receipt custom `toJSON`: DENY before signature verification.
- Existing ACK-loss, signed scope, ABA signature, immutable callback, grant/revoke, clock and elevation tests retained.

## AI-09 read-only Windows evidence checklist (NOT_RUN here)

In an **owner-approved, read-only** PowerShell terminal on the designated Windows machine:

```powershell
whoami /user
whoami /groups
Get-ScheduledTask | Where-Object TaskName -match 'Nexowire|Broker|Hub' |
  Select-Object TaskName,State,@{Name='RunAs';Expression={$_.Principal.UserId}},@{Name='Level';Expression={$_.Principal.RunLevel}}
Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-TaskScheduler/Operational';StartTime=(Get-Date).AddHours(-24)} -ErrorAction SilentlyContinue |
  Where-Object Message -match 'Nexowire|Broker|Hub' |
  Select-Object -First 30 TimeCreated,Id,LevelDisplayName
```

Record token elevation, task principal, last result, signed runtime image, process principal/integrity, version and broker health through **protected authenticated channels**. Compare DPAPI **metadata and intended scopes** (CurrentUser vs LocalMachine), never dump ciphertext or plaintext credentials. Do not infer exact cause from `0x800710E0` alone. A task marked Running, HTTP 401, or a synthetic admission fixture is not a successful elevated effect.

For physical positive acceptance, AI-09 must independently verify owner consent, real HIGH token, independent native Windows admission, one authorized effect receipt/readback, ACK-loss no-replay and revoke => DENY, reboot persistence, credential loading and rollback. All physical checks here remain **NOT_RUN**.

## Source-only rollback

Revert this Draft PR's commit on its own branch. No production state rollback is needed because no device or credential mutation is performed.

## Validation

Pending exact-head Node22/Node24 and Windows CI for this Draft; never reuse CI from base SHA as proof for the new source SHA.
