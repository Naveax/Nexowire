# #588 large-file transfer + #539/R15 user acceptance (K19)

Snapshot: upstream `Naveax/Nexowire` `main` at `4e7db16f4233048a956664bef6b607781eb63fb7`, 2026-11-07. Related issues: [#588](https://github.com/Naveax/Nexowire/issues/588) and [#539/R15](https://github.com/Naveax/Nexowire/issues/539). This file is QA evidence and acceptance guidance, **not a change to transport, authorization, artifact storage or an installed Agent**.

## What the 220 KB complaint means (T-363)

The user reported a ~220 KB failure. That observation alone does not establish whether the rejecting layer is ChatGPT attachment/tool framing, Hub, Agent, file capability, relay, or artifact storage. The current source has several **different** bounds:

| Layer | Current source contract | What this run proves |
| --- | --- | --- |
| Direct `file_transfer_between_devices` MCP tool, [`src/mcp/create-server.ts`](../../../src/mcp/create-server.ts) | Public `max_bytes` is optional, capped at **8 MiB**; uses internal bounded operations | Source inspection only; live MCP call **NOT_RUN** |
| Direct copy helper, [`src/mcp/cross-device-file-transfer.ts`](../../../src/mcp/cross-device-file-transfer.ts) | **48 KiB** chunks; internal total maximum **64 MiB**; atomic no-overwrite stage publish; no resume | Isolated filesystem fixture verifies 221 KiB and 1 MiB; 256 MiB + 1 rejected before byte transfer |
| Agent file capabilities, [`src/agent/executors.ts`](../../../src/agent/executors.ts) | Bounded ranged reads, positioned writes, hash/move, path policy | Used against two separate temporary local directories (not real devices) |
| Hub Artifact Bridge ingestion, [`src/mcp/artifact-bridge-device-ingest.ts`](../../../src/mcp/artifact-bridge-device-ingest.ts) | 64 KiB chunks, up to 32 per call, `PARTIAL` resume, source total <=256 MiB | Source inspection only; no live Hub or end-to-end artifact ingest here |
| Artifact manifests, [`src/workspace/artifact-bridge.ts`](../../../src/workspace/artifact-bridge.ts) | Current manifest and chunks bound to **256 MiB** | No >256 MiB acceptance claimed; schema/store changes are owner-only |
| ChatGPT/client/provider transport | External frame/body/attachment limits may differ | **UNKNOWN**; requires actual request IDs, upstream errors and wire evidence |

The 8 MiB direct MCP ceiling and 256 MiB Artifact Bridge ceiling are distinct from the reported ~220 KB error. We cannot call the original incident resolved solely because a **local** 221 KiB or 1 MiB transfer succeeds.

## Reproducible bounded local matrix

Run:

```bash
node --import tsx test/delegated/k19/issue588-large-file-acceptance.test.ts
```

| Input | Harness | Expected evidence | Physical status |
| --- | --- | --- | --- |
| 221 KiB patterned binary | Real temporary filesystem and scoped file capabilities; 48 KiB reads/writes | SHA-256 of source, destination and receipt agree; no single whole-file tool payload | Offline only; two-device NOT_RUN |
| 1 MiB Unicode filename/binary | Same path policies, independent source/destination directories | Bounded chunks, count and byte total agree; filename preserved; stage absent after publish | Offline only; browser/Windows NOT_RUN |
| Interrupted after first chunk | Injected second-read failure over local file capabilities | No success receipt, no final destination or orphan stage in this fixture | Simulated loss only; true network UNKNOWN |
| Destination pre-exists | Independent target bytes, atomic no-overwrite publish | Original bytes unchanged; explicit `overwrite:true` + atomic no-overwrite request rejected | Offline only; actual user permission UI NOT_RUN |
| Successful publish then external modification | Explicit local post-publication writer | Earlier `COMPLETE` receipt cannot attest the **later** bytes; independent digest readback catches mismatch | No continuous trusted device attestation claimed |
| 256 MiB + 1 metadata | No large file allocated; only source stat stub | Helper rejects before hash/read/write; **known outstanding limit** | Not a successful large-file transfer |
| 1 GiB, >4 GiB | No allocation/test this turn | Must use bounded stream, disk/quota grants, replay/CAS and safe integer proof in owner implementation | **NOT_RUN** |

## UI wording and negative boundaries (T-364–T-367)

These are proposed phrases, **not an already implemented screen**:

| Situation | Safe wording | Do not show |
| --- | --- | --- |
| Request pending | `Aktarım sürüyor; hedef dosyanın son doğrulaması bekleniyor.` | Percent complete without reliable streaming receipts |
| Interrupted/timeout/lost ACK, no trusted readback | `Aktarımın sonucu bilinmiyor (UNKNOWN). Hedefi doğrulamadan yeniden deneme.` | `Tamamlandı`, `başarısız oldu ve tekrar güvenli`, `kaldığı yerden sürer` |
| Target pre-exists or overwrite requested | `Hedef dosya korunuyor; mevcut içeriği silmeden/yazmadan farklı ad veya doğrulama seç.` | Being an owner implies automatic overwrite permission |
| Verified transfer | `Hedef dosya beklenen boyut ve SHA-256 ile doğrulandı.` | Source-only completion proves ongoing device authorization or permanent immutability |
| Unicode/long filename | Keep full basename available to assistive technology; preview may shorten at grapheme boundaries | Display full private source path as a public status label |

**Completion rule (#539/R15, T-366):** Distinguish (1) internally verified chunk digest, (2) committed/published tool receipt, and (3) *fresh, independently authorized* destination readback with expected size and SHA-256. A tool `COMPLETE` result is evidence of an operation, but cannot prove later bytes remained unchanged. If readback fails/is unavailable or is outside the current authorization, render **UNKNOWN** rather than fabricating completion. Never bypass an owner grant to obtain that readback.

## Live acceptance checklist (T-368)

- [x] Isolated local file read/write/move and digest evidence, including >220 KiB; no real connection used.
- [x] Negative cases for interruption, name collision, forced overwrite flag and a stale completion receipt.
- [ ] Capture the original user ~220 KB reproduction's request ID, full tool/error layer, bytes on the wire and provider HTTP status without secrets.
- [ ] Verify actual ChatGPT UI/provider size behavior and distinguish platform-owned limits from Nexowire-owned limits.
- [ ] Deploy matching authorized Hub and Agent builds only through owner release/canary/rollback gate; use two separate permitted test devices and disposable files.
- [ ] Verify owner/account/project grants, both device path scopes and revocation throughout the tested operation; reject cross-account paths.
- [ ] Real 221 KiB, 1 MiB, 256 MiB + 1 and 1 GiB transfer with disk/quota evidence, backpressure, interruption/resume and digests (only if owner implementation actually supports them).
- [ ] Real Windows NTFS no-overwrite, Unicode path, external interruption and orphan-stage/recovery behavior; capture OS and build versions.
- [ ] Exact-head GitHub CI jobs success, main integration, live installed/rollback acceptance and original incident retest.

Until the unchecked items have independent evidence, mark #588 **OPEN / source QA only**, not resolved. Existing owner coordination PR [#1096](https://github.com/Naveax/Nexowire/pull/1096) contains protected Agent/Hub/Broker changes; K19 must not edit those files or infer their successful deployment.
