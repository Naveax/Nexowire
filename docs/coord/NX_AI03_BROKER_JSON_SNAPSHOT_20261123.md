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

## Additional CORE console boundary fix and discoverable tests

A second owned boundary, `src/agent/core-console-admission.ts`, previously called `JSON.parse(JSON.stringify(input ?? null))` **before** native provider inspection. It now reuses `prepareCoreWindowsMutation`'s descriptor-based immutable snapshot, converts malformed values to `CORE_CONSOLE_INPUT_NOT_CANONICAL`, and leaves replay ID reservation and all owner/desktop/epoch/native checks unchanged.

New root-level negative tests in `test/core-console-admission.test.ts` assert zero getter execution, zero provider inspection, and zero effects for getter/toJSON/sparse input. A second small suite `test/ai03/broker-effect-snapshot.test.ts` is deliberately one directory below `test/` so the legacy `npm test` glob discovers smoke coverage even while #1205's full test-discovery repair is separate AI-08 work. This is not a substitute for running the full root-level tests explicitly.

The AI-03-specific workflow can be SKIPPED for a nonmatching branch name. If so, record SKIP and request a targeted run through coordinator/AI-08; do not claim a skipped job PASS, and do not edit protected workflows outside this agent's ownership.

## Coordinator review closure: Proxy trap boundary

The 23 November coordinator review correctly identified that `Object.getPrototypeOf`,
`Reflect.ownKeys`, and `Object.getOwnPropertyDescriptor` can invoke hostile
JavaScript **Proxy traps** despite previously rejecting getters and toJSON.
The new defense uses `node:util` `types.isProxy(value)` **before** any
object introspection, recursively in both:
- `src/agent/privileged-broker-effect-admission.ts` (`snapshotPlainJson`)
- `src/agent/core-windows-mutation-dispatch.ts` (`canonical`)

`core-console-admission.ts` already delegates to the second function, so
CORE console also denies root/nested/revoked Proxies before native inspection.
Dedicated negative tests assert **zero getPrototypeOf/ownKeys/descriptor
traps** and zero non-`then` property reads for asynchronous Proxy receipts,
zero Broker authority CAS for invalid effect inputs,
zero receipt verification for invalid reserve, no effect callback and zero
CORE provider inspection. A top-level Proxy returned by an **async provider**
can receive a `get('then')` trap during built-in Promise resolution BEFORE
`snapshotReceipt` is entered. The guard cannot prevent this JavaScript
language behavior. Tests explicitly distinguish this unavoidable thenable
assimilation from accesses made by the snapshot and assert DENY/no native
effect. Production providers must return decoded/authenticated JSON data
without in-process Proxy objects. Never claim that the snapshot function
prevents arbitrary side effects inside a compromised async provider.

`types.isProxy` is Node 22+/V8 native detection, not a recursive scan
by itself. Depth-first guards in the existing snapshot/canonical walkers
cover nested values; this does not imply an untrusted in-process Object can
be safely serialized by arbitrary other modules.

### Capability-by-capability source acceptance (physical evidence: NOT_RUN)

| Capability class | Example | Source status | Positive physical acceptance |
|---|---|---|---|
| General CORE executor mutations | `executeCoreWindowsMutation` | `CORE_EXECUTOR_DISPATCH_ENABLED=false`; deny by default | NOT_RUN |
| OS task subprocess sandbox | `shell.exec`, `wsl.exec`, `process.start`, `task.graph.run` | `OS_TASK_SANDBOX_UNAVAILABLE` for CORE/Broker-routed use | NOT_RUN |
| Direct mutable files / update / registry user scope | `files.write`, `nexowire.update.apply`, `windows.registry.set` | `CORE_NATIVE_EFFECT_ADMISSION_REQUIRED` unless a separate elevated-route guard is applicable | NOT_RUN |
| Privileged Broker effect claim | `windows.firewall.control`, machine registry/environment | Source-only `invokeBrokerEffectOnce` requires external one-shot binding, reserve+commit, verified signed receipts and fresh HIGH token | NOT_RUN |
| Physical console / GUI | `windows.pointer.click`, `windows.keyboard.type` | Synthetic enrollment/epoch/native provider tests exist; real owner consent/native provider not established here | NOT_RUN |
| Read-only status | `windows.console_control.status` | Status does not prove an authorized effect | NOT_RUN |

No runtime guard is disabled. The positive matrix requires **independently
authenticated native Windows evidence**, per-capability reversible effect,
owner approval, stable UUID/no replay, revoke/drain, reboot and rollback.
AI-09 remains physical executor; AI-03 does **not** claim CORE fully enabled.

### Protected provenance update request (coordinator/AI-08)

These are source-only modifications. The existing 290- and 243-row
provenance CSVs include `core-console-admission.ts`,
`core-windows-mutation-dispatch.ts`, and
`privileged-broker-effect-admission.ts`. For all evolved source blobs,
preserve the original Git source SHA, row count and original classification
audit trail; `EXACT_SOURCE_BLOB` cannot remain exact if the candidate blob
changes. Independently review new candidate SHAs before updating protected
matrices. This AI-03 branch does **not** write the protected matrices.
