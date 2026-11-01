# Cross-device file transfer: user-state and evidence inventory (K19)

Scope: source inspection and offline fixtures only, based on upstream `Naveax/Nexowire` at `93b6df33ef58610dcfdf3584bfe774e5afa7df4d` (2026-11-01). This is **not** a deployed file-transfer UI, a change to authorization, or a real two-computer acceptance result.

## Implemented contract versus proposed user wording (T-109)

| State a user needs | Observable source contract | Safe user-facing interpretation | Status |
| --- | --- | --- | --- |
| Request prepared | `file_transfer_between_devices` requires explicit, different source/destination device IDs and paths | "Kaynak ve hedef seçildi; aktarım sonucu henüz bilinmiyor." | Input contract; no dedicated progress UI |
| Request running | The server reads and writes chunks, hashes both sides, then tries atomic publication | "Aktarım sürüyor; hedef dosya henüz doğrulanmadı." | Internal work, **no progress events** |
| Bytes staged | `bytesTransferred` accumulates internally, but no intermediate MCP receipt is sent | Never label a byte count or 100% as "tamamlandı" | No intermediate user-visible field |
| Completed | `commitStage` resolves after source/stage SHA-256 checks, then helper returns `{state:'COMPLETE',bytesTransferred,sha256,chunkCount,destination}` and MCP wraps it as `ok:true` | "Aktarım tamamlandı" is appropriate **for this returned operation**, not a substitute for physical multi-device acceptance | Implemented success receipt |
| Explicit failure | Errors return `ok:false`, generally `TRANSFER_FAILED`; helper also has more specific `TRANSFER_*` codes | "Aktarım başarısız. Hedefte dosya olup olmadığını doğrula." | Failure envelope, **no dedicated localized UI** |
| Outcome uncertain | An acknowledgement may disappear after the destination was published; server may only report generic failure | "Sonuç bilinmiyor (UNKNOWN). Hedef dosyayı doğrulamadan yeniden adlandırma/silme/üzerine yazma." | **Proposed display rule; not implemented** |
| Existing destination | Atomic no-overwrite publication refuses a name collision; prior destination remains untouched | "Bu isimde dosya var. Mevcut dosyayı koru; istersen farklı ad seç." | Failure path; **no dedicated collision dialog** |

Source anchors:

- [`src/mcp/create-server.ts`](../../../src/mcp/create-server.ts): MCP input schema (`max_bytes` up to **8 MiB**), remote file operations, success/failure envelope; explicit distinct-device check.
- [`src/mcp/cross-device-file-transfer.ts`](../../../src/mcp/cross-device-file-transfer.ts): bounded **48 KiB** chunks, source/stage SHA-256 comparison, final `commitStage` before `COMPLETE`, best-effort staging cleanup. The standalone helper's **64 MiB** maximum differs from the current MCP tool's 8 MiB public ceiling; neither value implies that a larger real transfer is accepted.
- [`docs/CROSS_DEVICE_FILE_TRANSFER.md`](../../../docs/CROSS_DEVICE_FILE_TRANSFER.md): documented deployment caveats, copy-only operation, **no resume**, destination collision and physical two-device limit.

There is no present transfer-specific browser page that receives chunk progress, no percent-complete stream, no retry button with verified reconciliation, and no user-visible UNKNOWN state that these tests can certify. The wording above is a **design/acceptance recommendation**, not evidence that a screen already displays it.

## QA and failure/acceptance matrix (T-110–T-114)

| Scenario | Offline check in `test/delegated/k19/file-transfer-user-contract.test.ts` | Required real UI/physical acceptance, currently NOT_RUN |
| --- | --- | --- |
| Exactly 8 MiB, many chunks (T-110) | Promise remains pending even when all chunks have been staged, until the publish gate opens. `COMPLETE` appears only after it resolves; no intermediate percent field. | UI must not show 100% or success on byte count alone. Test a real large-file transfer on two disposable folders and devices. |
| Midstream disconnection (T-111) | Second chunk read throws; no `COMPLETE`, no published destination; simulated stage is cleaned. | Interrupted network or lost response should display **UNKNOWN** if destination state cannot be verified. Verify artifact status on target before any retry. |
| Target file already exists (T-112) | Publication rejects and preserves existing bytes; stage cleanup is checked. | Show a distinct conflict notice; never silently overwrite. Test on supported target filesystems (including Windows NTFS). |
| Publish succeeded, acknowledgement lost (T-113) | First call reports failure although destination was published; retry refuses to replace it. | Verify target path, size and SHA-256 before calling the first attempt failed or retrying under another name. Do **not** infer failure from a timeout. |
| Offline success vs two-device acceptance (T-114) | Isolated in-memory fixture returns `COMPLETE`. | Real account/device grants, two deployed agents, disconnect/reconnect, destination no-overwrite, Windows/Linux filesystem behavior and actual MCP tool response remain **NOT_RUN**. |

### Retry acceptance rules (T-113)

1. After a definite pre-publish rejection, disclose the error; do not imply a destination was created.
2. After any timeout or lost acknowledgement, label outcome **UNKNOWN**, never "failed and safe to retry".
3. Inspect the destination through an independently authorized, trusted readback (existence, size and SHA-256). Match against a pinned expected source digest.
4. If the destination exists with matching content, report "already present / verified"; do not overwrite it. If it differs, report a name conflict and request a different path. If verification is unavailable, keep **UNKNOWN**.
5. Existing transfer code **does not implement resume or automatic reconciliation**. A new attempt starts over; users must not infer idempotent resumed transfer from a repeated request.

### Evidence limits

Running `node --import tsx test/delegated/k19/file-transfer-user-contract.test.ts` proves only the helper's behavior against simulated `CrossDeviceFileTransferOps`. It does **not** exercise the real MCP endpoint, remote-agent authorization, durable transfer continuity, actual network uncertainty, filesystem hard links, a rendered UI or two PCs. The existing repository's separate cross-device integration tests also explicitly describe isolated simulated agents. Mark these physical and UI checks `NOT_RUN` until independent evidence exists.
