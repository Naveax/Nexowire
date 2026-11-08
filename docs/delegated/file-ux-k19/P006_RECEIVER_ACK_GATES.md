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
