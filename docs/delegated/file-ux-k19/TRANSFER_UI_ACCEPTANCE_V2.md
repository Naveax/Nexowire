# File transfer UX: uncertainty, retry, naming and storage acceptance (K19, P002)

Status: **test-only reference and acceptance criteria**, not a shipped interface. Source snapshot: upstream `Naveax/Nexowire` `93b6df33ef58610dcfdf3584bfe774e5afa7df4d`. No live Agent, Hub, account, browser or second PC was used.

The reference examples are executable in `test/delegated/k19/file-transfer-copy-reference.test.ts`. They specify how a future UI should *describe* outcomes; they do not assert an existing UI already does so.

## User messages / negative rules (T-224–T-227)

| Evidence at the caller | State to show | Recommended Turkish text | Forbidden inference |
| --- | --- | --- | --- |
| Request active; no final receipt | IN_PROGRESS | `Aktarım sürüyor; hedef henüz doğrulanmadı.` | 100% or complete from chunk count alone |
| Interrupted transfer, generic failure or missing reply; target not independently checked | **UNKNOWN** | `Aktarım sonucu bilinmiyor; hedef dosyanın durumu doğrulanmadı.` | A timeout proves no file was published |
| Trusted MCP `ok:true` plus final `COMPLETE` receipt | COMPLETE | `Aktarım tamamlandı.` | This proves a live second-PC test was run |
| Independent authorized readback, expected size and pinned SHA-256 match | VERIFIED | `Hedef dosya bağımsız SHA-256 doğrulamasıyla eşleşti.` | This is evidence of automatic retry/resume |
| Independently verified target is present but its bytes/digest differ | CONFLICT | `Hedef dosya mevcut ancak beklenen içerikle eşleşmiyor.` | Delete, rename or overwrite a pre-existing file automatically |
| `EEXIST`-like lower-level error without target readback | **UNKNOWN** (until confirmed) | `Hedef dosyanın durumu doğrulanmadı.` | Any untyped `TRANSFER_FAILED` string is reliable conflict classification |
| Cleanup was attempted or skipped; no stage existence readback | Cleanup UNKNOWN | `Geçici dosyanın temizlendiği doğrulanmadı.` | Best-effort cleanup means all temporary files are gone |

**Retry sentence:** `Doğrulama olmadan yeniden deneme. Bu işlem kaldığı yerden devam etmez.` The direct cross-device pilot is copy-only and **not resumable**. An acknowledgement can be lost after the destination was published; request failure alone must not trigger an overwrite or a "safe to retry" banner. See [`docs/CROSS_DEVICE_FILE_TRANSFER.md`](../../../docs/CROSS_DEVICE_FILE_TRANSFER.md) and [`src/mcp/cross-device-file-transfer.ts`](../../../src/mcp/cross-device-file-transfer.ts).

For a long or Unicode filename, preserve the full basename as the accessible label; a visual preview may shorten at grapheme boundaries with `…`. Do not show the account's full path when the screen only needs the filename. The test reference exercises combining marks and emoji sequences for both Windows and POSIX separators. Actual DOM, zoom, screen-reader, browser layout and keyboard acceptance remain **NOT_RUN**.

## Real two-PC / account and permission acceptance matrix (T-228)

Every row below is a **future controlled test**, never a current PASS. Run only with explicit owner/Ömer approval, disposable directories/files and appropriately authorized test devices; this task has no authorization for real device testing.

| Scenario | Required setup or evidence | Expected acceptance condition | Result |
| --- | --- | --- | --- |
| Two explicitly chosen devices in one authorized account | Distinct device IDs; valid source read and destination write/move/delete permissions under the same authenticated scope | Tool handles copy in bounded chunks, target digest matches, only then reports complete | NOT_RUN |
| Different owner/account or unauthorized second device | Separate test identities and per-device grant observations | Request denied; no transfer staged/published or cross-account data exposed | NOT_RUN |
| Restricted MCP credentials | Check composite tool and `file_read`, `file_stat`, `file_hash`, `file_write`, `file_move`, `file_delete` grants | Tool unavailable/denied if any required grant is missing | NOT_RUN |
| Device revocation mid-transfer | Two throwaway devices and a controlled revocation point | No invented continuous authorization guarantee; record exact policy boundary and whether external side effect began | NOT_RUN |
| Network interruption and lost response | Fault injection during chunks and separately after publish | Outcome UNKNOWN until independent readback; do not auto-delete destination or retry | NOT_RUN |
| Existing target with same name | Pre-populated destination with distinct content | No overwrite; verify original bytes and classify collision with readback | NOT_RUN |
| Windows NTFS and non-hard-link filesystem | Disposable folder on each target type, deployed matching agent versions | Atomic same-directory no-replace behavior on supported FS; unsupported FS fails closed | NOT_RUN |
| Empty/8 MiB file, long Unicode destination name | Throwaway source/target, path allowlist, both deployed agents | Bound, checksum, correct filename/UX and no false progress | NOT_RUN |

The earlier five in-memory helper tests and this turn's five test-only presentation checks are **offline/synthetic**. They do not establish independent authenticated identity, device-held keys, a trusted host, real file permissions or actual Windows hard-link behavior.

## Artifact and temporary-file wording (T-229)

There are **two different mechanisms**, and the UI must not conflate them:

1. `file_transfer_between_devices`: direct two-Agent file copy. Destination stages to `.nexowire-upload-<UUID>.tmp` and attempts same-directory atomic no-overwrite publication. On a known-owned stage after failure, cleanup is best effort; if stage creation failed or ownership is uncertain, automatic deletion is skipped. Orphan temporary files may remain; this copy has no durable resume. **Safe wording:** `Geçici dosyanın temizlendiği ayrıca doğrulanmadı.` Do not claim automatic deletion or resumable upload.
2. `artifact_bridge_ingest_device_file`: a separate Hub-backed project-artifact ingestion path. [`src/mcp/artifact-bridge-device-ingest.ts`](../../../src/mcp/artifact-bridge-device-ingest.ts) can return `PARTIAL`, `ALREADY_PRESENT`, or `COMPLETE` with a bounded per-call chunk budget and persisted session; its offset is a separate artifact-staging concept, **not** direct cross-device file-copy progress. [`src/workspace/artifact-bridge.ts`](../../../src/workspace/artifact-bridge.ts) preserves completed manifests/content-addressed objects in offline pruning. Expired session deletion is dry-run by default and requires operator-confirmed Hub shutdown for actual deletion; orphan stages require review. **Safe wording:** `Proje artifact oturumu kısmi; tamamlanma ve saklama durumu ayrı doğrulanmalı.` Do not advertise direct-device transfer resume on the basis of Artifact Bridge support.

### Release checklist for user-visible copy

- [x] Reference policy fixture exercises unknown interruption, ambiguous lost ACK, safe conflict copy, no-resume retry text, Unicode grapheme shortening and unverified cleanup (offline only).
- [x] Product source boundaries and the two different transfer mechanisms identified without modifying either.
- [ ] Integrate presentation policy in an explicitly owned UI area after design/owner approval (K19 owns only tests and docs).
- [ ] Render and inspect the actual UI with long names, screen-reader label, 320/375/768px width and 200/400% zoom.
- [ ] Confirm live MCP error envelopes and reliable readback of target digest under correct authorization.
- [ ] Obtain two-PC, Windows and real-account permission evidence. Until then **NOT_RUN**, not PASS.
