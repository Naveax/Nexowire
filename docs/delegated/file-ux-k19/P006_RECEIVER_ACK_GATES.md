# Issue #588 / #539 R15 — sender bytes versus receiver proof (P006)

Baseline: upstream `main` `52d452f717d891eeaf4c2b9aff3c6e1ea68369b0`
(2026-11-08); **not a live two-device run**. P006 T-643–T-648 test
source paths are entirely under K19 ownership. Protected Agent/Hub,
cryptographic receipt issuer, admission, and authorization are unchanged.

## Concrete finding and observed local counterexamples

`test/delegated/k19/p006-receiver-ack-reference.test.ts` exercises two real
local temporary-file paths and a strict **reference-only** UX state gate:

| Input evidence | Reference display | Local observation |
| --- | --- | --- |
| 221 KiB source/staged bytes written, exact source SHA-256, receiver target absent | `UNVERIFIED` | PASS: sender local success does not mean receiver applied |
| 1 MiB + 19 B staged/hashed; final destination not acknowledged | `UNVERIFIED` | PASS: sender hash is not receiving-device acknowledgment |
| Destination exists after publish but ACK packet disappears | `UNVERIFIED` | PASS: do not claim delivered or suggest automatic resume |
| Sender progress 100% and a matching ACK **without fresh independent receiving readback** | `UNVERIFIED` | PASS: progress is not final acceptance |
| ACK has wrong receiving device, operation ID or destination path | `UNVERIFIED` | PASS: wrong scope cannot certify target |
| Mock ACK **and independently read final bytes/hash** from matching destination | `VERIFIED` **in reference fixture only** | PASS: a subsequent separate writer makes readback mismatch and revokes confidence |
| Exclusive destination copy hits verified name collision | `CONFLICT`, existing bytes preserved | PASS: plain EEXIST alone remains `UNVERIFIED` |
| Partial bytes sent / impossible over-count | `SENDING` / `UNVERIFIED` | PASS: neither is final receipt |

These eight local tests are intentionally stronger than checking only a
successful `writeFile()` or matching sender hash. The source code's actual
MCP transfer receipt can still represent only its own execution; this
reference model **does not establish an authenticated remote receipt** and
must not be wired into product code without owner design and live acceptance.

## UX wording gate (T-645 / T-647)

- `SENDING`: *Aktarım sürüyor; teslim henüz doğrulanmadı.*
- `UNVERIFIED`: *Baytlar gönderilmiş olabilir; alıcı teslimi doğrulanmadı.*
- `CONFLICT`: *Hedefte zaten dosya var; üzerine yazılmadı.* — only after
  independently verifying the existing destination; a generic remote error
  is not sufficient.
- `VERIFIED`: *Alıcı dosyası bağımsız olarak doğrulandı.* — require exact
  operation ID, receiving device ID, target path, byte count, SHA-256,
  explicit receiver ACK, **and** a fresh authorized final readback.

100% local transfer progress is not an end-to-end completion percentage. No
automatic overwrite and no promise of resumability. The real production UI
was **NOT_RUN**; all listed strings are proposed test-only reference copy.

## Hosted test discovery (T-646 / #1006)

Companion [PR #1136](https://github.com/Naveax/Nexowire/pull/1136) exact
HEAD `ed5fa137bc875e613691e13d1b72a8df9ebf9d56` CI run
[42474024855](https://github.com/Naveax/Nexowire/actions/runs/42474024855):
**7/7 jobs success**, but inspection of the actual `test (22)` job
`128711198288` log shows explicit *old* K19 tests and **no**
`p005-ci-discovery-qa.test.ts`, `issue588-large-file-acceptance.test.ts`, or
`issue588-limits-inventory.test.ts`. Those new individual K19 tests did
**not** run in this hosted workflow. A green aggregate does not change the
coverage classification `NOT_RUN`. K13 owns CI discovery and may separately
run some nested tests in [#1134](https://github.com/Naveax/Nexowire/pull/1134);
proof requires the exact path, commit and log/run ID for **each** claimed test.

## Real two-PC / Hub acceptance gate (T-648)

Owner may use the deterministic 221 KiB PowerShell sample from #1136's
`P005_TRANSFER_ACCEPTANCE_CI.md` on explicitly authorized Windows machines.
Record only redacted evidence, no credentials or customer files:

1. Source SHA-256 and size for 221 KiB and 1 MiB+; source device, destination
   device, allowed path, version/commit, transfer/tool name, request ID.
2. Sender stage written and completion response; **separate** receiver final
   path, size and SHA-256 after publish with authorized receiving-device I/O.
3. Receiver's operation/target/device-bound acknowledgment, including source
   of that proof, not just sender's hash or the Hub's queued response.
4. Stable link, controlled disconnect before ACK, and duplicate destination
   cases. For each, record unchanged old target and whether side effects
   occurred; don't rerun a destructive copy against real data.
5. Compare ChatGPT/client preflight, MCP admission, Hub, Agent stage/final
   publish and receiver on-disk readback. Identify the **first failing**
   boundary for issue #588 with redacted correlation ID.

No test machine, live user account, Hub, provider, real Windows UI or
receiving-device authority was used in this PR. Physical acceptance:
**NOT_RUN**. Issue #588 remains open. No production receiver-ack fix claimed.

## P007 D-109–D-114 owner handoff / four-PR reconciliation (2026-11-08)

On current upstream `main@52d452f717d891eeaf4c2b9aff3c6e1ea68369b0`,
the four actual source blobs below are **byte-identical** on owner #1096
`b675897dce171a4f5e7a7ccb3187a16ac13630d0`:

| Layer / source | Main and owner-branch blob SHA | Bound / owner implications |
| --- | --- | --- |
| `src/mcp/create-server.ts` | `9e8cbe6d59910f7b05adc7da7776eae60edd776b` | Direct MCP public max **8 MiB**; no new #1096 file-transfer bound |
| `src/mcp/cross-device-file-transfer.ts` | `f422dfa43a3fa8fc9e5fb692e74da948c4aaf6dc` | Direct helper max **64 MiB**, default 48 KiB chunks |
| `src/mcp/artifact-bridge-device-ingest.ts` | `ebee8010de8c5e05d8d5e8bf81ebee70991707f9` | Separate ingest source max **256 MiB**, 64 KiB chunks / 32 per call |
| `src/workspace/artifact-bridge.ts` | `c36a6c0ce3c373f622d862e4a41a6aaa13adf04a` | Separate artifact manifest max **256 MiB**, 4096 chunks |

Compared owner #1096's **315-file actual patch**: none of those four
source paths is changed. The patch *does* modify `src/agent/executors.ts`,
but its current hunks add Windows CORE/Broker dispatch admission, not a
file read/hash/write transfer-size override. This is **source comparison**,
not a test of a running Hub, Agent or ChatGPT upload. A user-reported
220 KiB transfer is below these particular size guards. **The original
failure was later found in the historical owner Work PC issue log**: an
HTTP `413` on the `/mcp` request path *before a tool result*, not a
demonstrated filesystem size ceiling. The precise proxy/ingress/Hub hop
producing the 413 remains **UNKNOWN** (details below).

Four existing K19 Draft PRs are open, unmerged, each with distinct files:

| PR | Exact HEAD at this audit | Unique payload | Required CI outcome |
| --- | --- | --- | --- |
| [#1111](https://github.com/Naveax/Nexowire/pull/1111) | `c5119a65a914ec339ad1c362ba9ba1ca19e339b4` | 221 KiB/1 MiB real local capability fixture + acceptance matrix | [42410254755](https://github.com/Naveax/Nexowire/actions/runs/42410254755): 7/7 generic success; new `issue588-large-file-acceptance.test.ts` **NOT_RUN** |
| [#1124](https://github.com/Naveax/Nexowire/pull/1124) | `4d1a3dc32bd8c6718392ec743769c5409e114f3c` | Nine source bounds, parser/negative test | [42411882607](https://github.com/Naveax/Nexowire/actions/runs/42411882607): 7/7 generic success; new `issue588-limits-inventory.test.ts` **NOT_RUN** |
| [#1136](https://github.com/Naveax/Nexowire/pull/1136) | `ed5fa137bc875e613691e13d1b72a8df9ebf9d56` | CI-discovery negative and physical repro | [42474024855](https://github.com/Naveax/Nexowire/actions/runs/42474024855): 7/7 generic success; new `p005-ci-discovery-qa.test.ts` **NOT_RUN** |
| [#1147](https://github.com/Naveax/Nexowire/pull/1147) | `3e60a55a9a88d83a7c8f14319112945ebd7df445` (prior to this doc-only update) | Receiver ACK/source SHA reference fixture | [42485370999](https://github.com/Naveax/Nexowire/actions/runs/42485370999): 7/7 generic success; new `p006-receiver-ack-reference.test.ts` **NOT_RUN** |

`test (22)` raw log job `128745953233` on #1147 explicitly calls
the two older K19 tests, not these four nested new test filenames.
The same absence was checked in `test (22)` jobs of the other three runs.
An auxiliary workflow or future main CI invocation is **not** treated as
coverage without exact file name, run ID and commit. K13 and owner #1096
own the necessary hosted discovery change. Do **not** re-dispatch the
already-started workflow for the same SHA.

On exact current main source, with #1111/#1124 files temporarily overlaid
**for local execution only**, K19 reran:

- `p006-receiver-ack-reference.test.ts` (this PR): **8/8 local PASS**.
- `issue588-large-file-acceptance.test.ts` (#1111): **5/5 local PASS**.
- `issue588-limits-inventory.test.ts` (#1124): **5/5 local PASS**.
- Existing `cross-device-file-transfer.test.ts` and
  `cross-device-agent-file-io.test.ts`: **16/16 local PASS**.
- `npm run typecheck` and `npm run build`: **PASS**.

Consolidation recommendation for ŞEF/Ömer: preserve the four unique test
files and their source/acceptance contracts; do not bulk-merge the four
Drafts, turn 7/7 generic success into hosted test success, or close issue
#588. Source paths and PR code changes don't overlap, but CI discovery,
owner approval, and physical two-PC acceptance are still distinct gates.
Owner-coordinated merge/PR-closure decisions are deliberately **not** made
by K19 under protocol V006. No new PR was opened for this P007 handoff.

## P007 follow-up: genuine Work PC #588 evidence versus K19 local fixtures (2026-11-08)

Rechecked **Naveax's original issue comment**, not just #588's title:
[Work PC HTTP 413 / successful bounded write, 2026-10-20](https://github.com/Naveax/Nexowire/issues/588#issuecomment-6289416326).
This is **historical owner-provided real-device evidence**, not a new K19
live-device test:

| Historical observation | What it proves / does not prove |
| --- | --- |
| Work PC Agent **1.0.5**: one `Nexowire.file_write` carrying approximately 230 KiB synthetic UTF-8 failed **before any tool result** with `INVALID_ARGUMENT / McpServerError` and HTTP `413 Request Entity Too Large` at tailnet `/mcp` | Confirms a **single serialized request / HTTP-path** failure, not a whole-file disk-size limit; the exact component returning 413 is **UNKNOWN** |
| Same authorized API: **231,474** synthetic bytes succeeded in four bounded calls (`65,536 + 65,536 + 65,536 + 34,866`), `file_stat` confirmed 231,474 bytes, `file_hash` SHA-256 `4be215a260d0c3eb3ba3717678b9eacacb5f396ac89c79650c2fd90dcabd0f91` | **Actual owner Work PC success**, not K19's local mock; does **not** constitute an idempotent or resumable production protocol |
| [Owner's separate #588 update](https://github.com/Naveax/Nexowire/issues/588#issuecomment-6290078921): 221 KiB physical cross-PC in four bounded writes; 1 MiB physical cross-PC in sixteen 64 KiB writes, SHA-matched | Historical **physical chunked-file evidence exists**; does not establish a **single logical request** that triggers an automatically managed stream, reconnect resume, or independently authenticated final receiver ACK |
| That update separately describes **256 MiB+1 B** and **1 GiB** source-only/isolated-Hub streaming acceptance | **Not** a deployed two-device Agent/Hub 1 GiB acceptance; do not claim current service capacity |

Owner clarified in [#588](https://github.com/Naveax/Nexowire/issues/588#issuecomment-6289689077)
that **one user instruction / one logical MCP invocation** should start an
automatically streamed, durable multi-device job; it does **not** mean
placing GB of bytes in one JSON request. Manual repeated `append` is unsafe
on uncertain acknowledgment (duplicate append or writer race). A production
protocol needs session/transfer ID, exact-offset compare-and-swap,
idempotency, target/device authorization, bounded memory, SHA verification,
and atomic publish—owned by the protected Agent/Hub/Artifact workstreams,
not implemented by these K19 UX reference tests. No new body-limit changes
or unsafe automatic retry are proposed here.

**Updated hosted check on exact #1147 HEAD**
`709639e80ec322d6735650d38688dce8a3d0c2ca`:
[Actions 42500690813](https://github.com/Naveax/Nexowire/actions/runs/42500690813)
**7/7 generic jobs SUCCESS**. Specifically the `test (22)` job
`128792553773` ran `test/delegated/k19/file-transfer-copy-reference.test.ts`
and `file-transfer-user-contract.test.ts`, but **did not invoke**
`p006-receiver-ack-reference.test.ts`, `p005-ci-discovery-qa.test.ts`,
`issue588-large-file-acceptance.test.ts`, or
`issue588-limits-inventory.test.ts`; these four nested cases are still
**hosted NOT_RUN**, although their separately reported local tests passed.

**Still open / routing:** confirm the 413-producing intermediary using
authorized redacted request/ingress logs and serialized wire sizes; prove
the current deployment rather than historic Agent 1.0.5; test durable
one-invocation transfer (including >256 MiB, restart/reconnect/replay,
collision, disk full), separate receiving-device final readback and
authenticated ACK. These are owner/ŞEF/CI-owner actions; K19 has not
changed protected service code, deployed anything, or closed #588.
