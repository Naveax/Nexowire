# NX AI-07 | Cross-device transfer evidence and physical acceptance handoff

Date: 2026-11-23 (Europe/Istanbul)  
Repository: Naveax/Nexowire  
Integration Draft PR: #1160  
Pinned integration source: `83c8b651106ecd1244fb9d982cf94fd390c15b6b`  
AI-07 branch: `agent/nx-07-transfer-replay-evidence-20261123`

## Scope and evidence discipline

The tests in `test/delegated/k18/ai07-cross-device-transfer-evidence.test.ts` use two **synthetic device IDs**, disposable `os.tmpdir()` storage and the actual imported `ArtifactBridgeStore` / `ingestDeviceArtifact` logic. The reconnect simulation creates a new store instance over the same disposable root. It does **not** simulate real WSS authentication, network handoff, physical boot, two-PC device identity, native dispatch, or a signed end-to-end final receipt.

On 2026-11-23 the Nexowire device inventory reported:
- `DESKTOP-ONDD84S`: ONLINE, native-agent 1.0.8.
- `Naveax`: OFFLINE, native-agent 1.0.8.

**Two-PC physical result: NOT_RUN.** No Work-PC or NAVEAX production task, Agent, Broker, Hub, credential, state, journal, SQLite or file was modified.

## Concrete source findings

1. `src/mcp/artifact-bridge-device-ingest.ts` rejects `stat.size > 268_435_456` with `INGEST_SOURCE_INVALID` before invoking source hashing or chunk reads.
2. `src/workspace/artifact-bridge.ts` independently caps manifest `size` at `268_435_456` bytes and limits chunks to 64 KiB / 4096 total. Hence **256 MiB + 1** and **1 GiB + 1** cannot pass the current artifact ingestion path. The separate Draft PR #596 proposes larger streams; its existence is not release acceptance.
3. `summarizeOfflineTransferProgress` in `src/ops/scale-transport-metrics.ts` is explicitly `SYNTHETIC_EVIDENCE_ONLY`. A supplied boolean called `finalReceiptVerified` does not become a device-authenticated final receipt just because a synthetic result displays 100%.
4. Existing `test/delegated/k18/p007-transfer-replay-integrity.test.ts` covers isolated 1 MiB chunks, source offset drift, sender digest mismatch, in-flight mutation and an oversized metadata-only request. The new test adds **221 KiB scope isolation across two device IDs** and **1 GiB + 1 metadata-only fail-closed** evidence.

## Validation matrix

| Case | Source-only expected evidence | Live two-PC requirement |
| --- | --- | --- |
| 221 KiB | PARTIAL, restart/resume, separate manifests per device, receiver independently recomputes SHA-256, ALREADY_PRESENT performs zero payload reads | Agent A -> Hub -> Agent B: signed owner/device/session and receiver receipt |
| 1 MiB | Existing `p007-transfer-replay-integrity.test.ts`: 8 bounded steps, independent receiver SHA-256 | Verified full receiver byte count and digest across reconnect |
| 256 MiB + 1 | Current ingest rejects before hashing/reading; **not a successful transfer** | After reviewed streaming implementation, bounded chunk resume to completion |
| 1 GiB + 1 | Current ingest rejects before hashing/reading; synthetic counters are not transfer proof | After reviewed streaming implementation, bounded-memory transfer, quota and disk checks |
| Lost ACK after persisted chunk | Existing K18 isolated error/recovery tests prevent premature commit | Match durable ACK and final authenticated receiver receipt; no blind payload replay |
| Connection drop/reconnect | Local store restart is only a durability proxy | Real WSS session epoch, authenticated identity, heartbeat and reconnect evidence |
| UNKNOWN idempotency | No synthetic PASS accepted | Fence automatic payload resend; inspect durable external CAS/commit evidence first |
| Physical reboot of both Windows PCs | NOT_RUN | AI-09 coordinates each permitted physical mutation and captures timestamps |

## Local execution (isolated developer machine / disposable CI runner)

```bash
node --import tsx --test test/delegated/k18/ai07-cross-device-transfer-evidence.test.ts
node --import tsx --test test/delegated/k18/p007-transfer-replay-integrity.test.ts
node --import tsx --test test/delegated/k18/ingest-ack-loss.test.ts
npm run typecheck
```

Run only in an isolated checkout. The repo's `npm test` glob `test/**/*.test.ts` may omit nested `test/delegated/k18/*` on some shells; AI-08 owns full test inventory/execution coverage and must attach an exact-SHA executed-file receipt. **Unexecuted tests remain NOT_RUN**, even if unrelated workflows pass.

## Physical AI-09 handoff, pending explicit owner approval

1. Recheck exact deployed source/package SHA on both machines, native Agent version, Hub and Broker identities, and device reachability. Require NAVEAX ONLINE before attempting transfer.
2. Use **new temporary fixture files** only, under user-approved paths on both machines; do not use personal files, production journal, or production database.
3. Capture source SHA-256/size and scoped device IDs, session/transfer identity, WSS epoch/reconnect timestamps, ACK offset evolution, receiver SHA-256/size, and independently authenticated final receipt. Redact secrets and credentials.
4. Exercise sizes in increasing order: 221 KiB, 1 MiB, then 256 MiB + 1 and 1 GiB + 1 only if supported by the reviewed deployed streaming path. For unsupported sizes report explicit **FAIL/NOT_SUPPORTED**, never fake PASS.
5. Inject network loss / missed ACK / sender restart in the disposable test transport. If operation is UNKNOWN, do not resend automatically; use operator-controlled readback and preserved evidence.
6. Verify both transfer directions and distinguish **source sent**, **Hub accepted**, **destination persisted**, and **destination independently verified**. A receiver-verified receipt is mandatory for physical PASS.
7. Check safe teardown, no leaked temporary tasks/storage, no cross-device data leakage and no replay after revoke; preserve error evidence.

## Rollback

For the new test and documentation, rollback is a Git revert of the AI-07 commits only; there is **no production state rollback** because no production mutation was performed. For later physical trials, AI-09 owns per-stage recovery and explicit operator permission. Never delete an UNKNOWN staged transfer as a substitute for reconciliation.

## Acceptance status at authoring

- Source test file added; runtime execution against the full repository: **NOT_RUN**, pending exact-SHA CI/test-runner evidence.
- Work-PC connectivity: ONLINE as observed; this is not CORE/SYSTEM or delivery acceptance.
- NAVEAX connectivity: OFFLINE.
- Two-PC file delivery/reboot/revoke: **NOT_RUN**.
- Initial #1160 General CI `45178026197` and Release Readiness `45178024621`: IN_PROGRESS when inspected; do not re-dispatch the same SHA/workflow/input.
