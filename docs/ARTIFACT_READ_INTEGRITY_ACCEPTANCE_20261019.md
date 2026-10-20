# Artifact Bridge: pinned-descriptor read integrity acceptance (2026-10-19)

Source: isolated follow-up to merged PR #552 and #573, main cb819d17ee581093d39626f13e985976def17f30, on Work PC. No live deployment and no existing user data touched.

## Confirmed security bug, pre-fix

ArtifactBridgeStore.readChunk previously performed SHA-256 verification via get(), then reopened the content-addressed filename to read the returned Base64 chunk. A controlled synthetic filesystem modification between these two events caused the old implementation to return tampered bytes under the original declared artifact digest. Baseline negative test FAILED with Missing expected rejection.

The negative test uses only disposable temporary files and hooks the exact open boundary. It does not touch production files or rely on speculative behavior.

## Source fix

ReadChunk now verifies the entire content SHA-256 and extracts the bounded requested range from **the same open file descriptor**. It checks regular-file type and file size before and after streaming and refuses altered or truncated contents. There is no period where a verified path is reopened to fetch different bytes. Tests include the original tampering reproduction, a 64 KiB-spanning range and a zero-length artifact.

## Acceptance evidence classes

PHYSICAL: Native Agent 1.0.5 on each Work PC and Naveax. Fresh synthetic files 131,081 bytes with identical names but different contents were transferred in **both directions concurrently** in 49,152 / 49,152 / 32,777 byte chunks. Both target SHA-256 values matched the respective source.

- Work PC to Naveax: 3aa2b441f61687f0b17698684a166bb6f2f44bab17535dca24d3cc7025c0db18
- Naveax to Work PC: 78de946816da3c5ff6f6202a1018d5f0f1f2c2e0fe7b5ac952e2404ae3314ec6

ISOLATED HUB SOURCE: Actual 131,081 byte physical fixtures ingested into a new isolated ArtifactBridgeStore on Work PC, with verified 49,152 byte resume, duplicate chunk idempotency, invalid offset denied, wrong account/project/device isolated, independent instance checkpoint retrieval, CAS and stale checkpoint detection. JSON SHA-256: 136a574fe5132c6787b331b982245871c4e67d1f63716c096bebaceed20fde92.

HERMETIC RESILIENCE: Merged regression suite passed for crash/lock recovery, offline backup/restore, retention default dry-run, orphan staging fail-closed, concurrent writers, and injected ENOSPC. These are not production service restart or actual disk exhaustion.

LIVE HUB: Connected plugin contains Native file tools and previous workspace_checkpoint_get/list, but no artifact_bridge_* MCP tools; both physical Agents report version 1.0.5. Two checkpoints from prior conversations were successfully listed and read through the existing connector. This is not automatic access to old ChatGPT temporary uploads and not hosted Artifact Bridge acceptance.

## Additional acceptance tooling limitation

The previously merged artifact-two-device-acceptance.ts test runner incorrectly uploads an entire remaining tail as one chunk after a 32,766 byte first chunk. At 131,081 bytes it fails correctly with INVALID_CHUNK (limit 64 KiB). An independent local acceptance harness was used to test this larger artifact in bounded chunks. This is a **runner-only limitation**; no mutation to the merged production ingest logic was needed. A separate dedicated runner maintenance could follow.

## Remaining production release blockers

- Hosted Artifact Bridge tools and owner/device grant enforcement not verified live.
- Real production TLS/WSS direct Agent-to-Hub ingest on two physical devices not verified.
- Encryption and atomic production backup/restore, quotas, retention for published objects, disk headroom monitoring, and operator recovery/lock procedures not accepted.
- Independent security review and exact-head CI required for this DRAFT branch. Do not merge/deploy as part of this acceptance thread.
