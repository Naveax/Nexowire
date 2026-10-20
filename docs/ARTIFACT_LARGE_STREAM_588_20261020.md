# Nexowire Artifact Bridge: large-file acceptance for issue #588

Date: 2026-10-20. Feature branch: feat/parallel-08-large-artifact-588-20261020.
Base main on worktree creation: 4d8bb072a01981be525fd7d0f800c0e2a62332f7.
Prior Artifact Bridge, recovery and read-integrity PRs #552, #573, #584 are integrated in the source base. This change is source-only and must stay DRAFT before independent QA.

## Contract

There is no artificially small total-file cutoff in the new v2 Artifact Bridge staging design. A single logical file may grow through bounded 64 KiB binary chunks and exact-offset durable receipts. **"No fixed small whole-file limit" DOES NOT mean infinite HTTP requests, infinite free storage, unlimited account quota, universal filesystem offsets or unlimited ChatGPT attachments.** File lengths must remain safe JavaScript integers and fit actual disk, storage quotas, API/Agent offset support and service resource limits. Configure NEXOWIRE_ARTIFACT_MAX_BYTES as an operator-side positive integer if an account service imposes a per-file hard quota. Hub additionally bounds at most 8 simultaneous unfinished sessions *per account/project/device scope* and reserves 64 MiB free storage at large-file admission. Production aggregate-account quotas and disk-pressure alerts still need policy and operational validation.

MCP put_chunk and read_chunk remain bounded to 64 KiB decoded content per request. The composite Agent-to-Hub ingest runs 1 to 32 small reads per invocation, transferring at most 2 MiB of binary data per tool call internally. Actual MCP input contains no file payload for this composite pull. Data are never returned to ChatGPT as one unbounded Base64 response.

## Reproduced ~220 KB failure: source and HTTP framing are different limits

PHYSICAL Work PC Agent 1.0.5: new synthetic file 221 KiB (226,304 bytes) successfully read by Nexowire file_read in a single request; reported Base64 length 301,740 characters and SHA-256 2a4b55f9db2abc50393c2ca1084ff9c911bc01f89a3e0ba9d8d816247b9e4f5b.

Sending the exact Base64 payload in a single Nexowire file_write call returned **HTTP 413 Request Entity Too Large** from the MCP request to https://nexowire.tail10f02d.ts.net/mcp. This reproduces an actual inbound HTTP request-framing limit. Without server/proxy logs it is not possible to assign the 413 unequivocally to the reverse proxy versus upstream Hub; this work does NOT change production HTTP service configuration. A ChatGPT platform attachment cap, if present, is separately controlled by that platform and cannot be removed by a Nexowire plugin patch.

Resent 221 KiB Work PC -> Naveax in four allowed Base64 writes of 65,536 + 65,536 + 65,536 + 29,696 bytes. Final SHA-256 matched exactly. A separate freshly created 1 MiB synthetic file was sent Work PC -> Naveax in 16 chunks of 65,536 bytes. Final SHA-256 matched 3a814d27145f9540c495715da2f85208f3805c323d7da3e9867df2992be4432d. During the 1 MiB test the orchestration call reached its tool-call budget after 10 confirmed chunks. The remote destination was then statted to 655,360 bytes, and that prefix SHA-256 was independently compared with the original Work PC prefix before sending the final 6 chunks. No blind duplicate overwrite or replay.

## Source implementation (scope: Store, ingest and MCP only)

1. Existing <=256 MiB legacy sessions and manifests remain compatible. Large v2 sessions keep a constant-size JSON header and an append-only binary receipt journal with **44 bytes per chunk** (8-byte offset, 4-byte length, 32-byte chunk SHA-256). No giant JSON array and no per-chunk all-history rewrite. All offsets and lengths are exact safe integers.
2. Strict monotonic offset CAS; idempotent exact-chunk replay; append to stage and receipt log, with staged data fsync before receipt acknowledgement. Interrupted or torn stages fail closed rather than claiming success. Restart validates every receipt against the staged bytes.
3. Explicit scoped cancellation, dry-run-first retention and offline-only prune support include large receipt files. Completed content-addressed objects and manifests are never deleted by cancel/retention.
4. Large Hub-pull uses batches of at most 32 individual 64 KiB source reads, committing one pair of fsyncs per batch (not per chunk). Owner/project/device authorization and existing native file path grants remain mandatory. The source size and, when available, last-modified identity are rechecked on reads; the declared full SHA-256 is verified against the completely assembled stage before atomic publish. For sources above the legacy Agent 256 MiB hashing limit, a precomputed expected_source_sha256 must be supplied; this is not independent Agent attestation.
5. The v2 manifest records a SHA-256 of the published receipt index. Each read_chunk verifies the bounded chunk index hash, extracts only matching original-commit chunks from a pinned file descriptor, checks their individual SHA-256 and returns at most 64 KiB. This avoids rescanning the entire GiB blob for each subsequent chunk read. Old content manifests without an index keep the full-file verification path added by PR #584.
6. Filesystem availability and a minimum reserve are checked at large begin. Configured per-file quota applies to ALL manifests, including legacy small files. Persistent ENOSPC returns failure; no metadata publication if stage/hash/receipt or manifest publication fails. There is no unbounded RAM stage.
7. Deliberately untouched: Native Agent file API, USB, OS-specific file offsets, Connection Core, OAuth issuance, operation journal, production hub or running agents.

## Verified evidence

| Case | Class | Result | SHA-256 |
|---|---|---|---|
| 221 KiB | Physical Work PC -> Naveax, 4 bounded writes | PASS | 2a4b55f9db2abc50393c2ca1084ff9c911bc01f89a3e0ba9d8d816247b9e4f5b |
| 1 MiB | Physical Work PC -> Naveax, 16 bounded writes | PASS | 3a814d27145f9540c495715da2f85208f3805c323d7da3e9867df2992be4432d |
| 256 MiB + 1 byte | Work PC isolated source Hub | PASS; 4,097 receipts, SHA+atomic publish | 7c694835141dcffe774166e0000fc8d94387ced2ad6b5c020f0d5e715b20f3e7 |
| 1 GiB | Work PC isolated source Hub | PASS; 16,384 receipts, SHA+atomic publish | c7a13e6a298c8501f688b9dfa66e0ea3c0e9e4f89301a564813b0e59a6f5abba |
| 256 MiB + 2 bytes | Isolated v2 published indexed reads | PASS; full blob SHA, index SHA, 4 bounded random reads | ea8acf9e95ba2b9ff27a6ba6556c55680b2731b05c58a0da16f414270a405f91 |

The indexed read evidence JSON under the newly created synthetic Work PC fixture folder has SHA-256 c8e995f7b092c8faee2c72c18e169b23cc6516da3a5157e29c8190eea1cb6772. Indexed read latency on the 256 MiB+2-byte synthetic file was observed as 5–14ms per tested bounded random-access chunk (test environment only, not a production SLA).

One-by-one 64 KiB fsync staging required ~151 seconds for 256 MiB. Using bounded 32-chunk batch persistence, each 256 MiB segment of the 1 GiB proof required roughly 8–11 seconds. These are local Work PC observations, not guaranteed transfer throughput.

The existing previous-chat workspace_checkpoint_list/get bridge successfully retrieves earlier persisted Nexowire project checkpoints when account/device-scoped connector permission exists. New artifact_bridge_* tools still require production deployment and authenticated hosted acceptance. No ChatGPT automatic access to previous temporary uploads was assumed.

## Acceptance and known remaining blockers

SOURCE/HERMETIC: New unit tests cover 221 KiB/1 MiB data, >256 MiB v2 receipt format, restarted offset, conflicting offsets, wrong device, cancel, retention and orphaned receipts, bad source mtime, configured quota, Unicode filenames, corrupt receipt indexes and tampered object bytes. Existing Agent/MCP/Windows/process security tests remain intact.

PHYSICAL: Validated 221 KiB and 1 MiB native file tool transfers with end-to-end destination SHA. This does NOT test production Agent 1.0.5 reading offsets >256 MiB. PR owner #05 must update/accept native file read/hash/write offsets separately, and signed rollout/canary must be approved before changes to live Agents.

STAGING: Reproducible Work PC isolated Hub store and synthetic filesystem acceptance. Not a hosted staging account. WAN TLS/WSS routing, issuer/account/device scope authorization and provider-side backpressure must be physically accepted by QA #16.

PRODUCTION: BLOCKED. Both running devices have Agent 1.0.5 and the currently connected Nexowire plugin may lack published artifact_bridge_* tools. No production deployment, quota entitlement change, HTTP 413 proxy reconfiguration or platform attachment cap change. Audit cross-tenant owner aggregate quotas, multi-host backups, disk-pressure/ENOSPC fault recovery, revision/source replacement, failure injection mid-batch, receipt directory durability and >1 GiB sustained soak before production enablement.

Coordinates: #05 Native file/USB offsets, #06 reconnect/unknown mutation response, #16 QA acceptance and #00 integration. No overlaps were edited here.

Exit statement: no artificial 220 KiB whole-file ceiling is necessary for Nexowire's own authenticated chunk-stream flow, but per-request HTTP limits, actual disk, quota, native offsets and ChatGPT-owned limits remain real. Keep the PR DRAFT pending exact-head CI and security review.
