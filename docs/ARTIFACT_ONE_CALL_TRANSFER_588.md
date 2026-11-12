# Issue 588: one-call cross-device transfer acceptance

Scope: source-only extension to DRAFT parent PR 596. Independent QA child PR 597 red test copied without changes into the parent. It was RED on previous source and is now PASS. No live Agent/Hub restart or deployment, no main merge, no user files edited.

## User-facing MCP ABI

artifact_bridge_transfer_start takes source_device_id, source_path, target_device_id, target_path, optional project_id, expected_source_sha256 and resume_transfer_id. It returns a transfer ID immediately; source bytes do NOT appear in the MCP request or response. One logical start call starts a durable Hub-side worker. artifact_bridge_transfer_status and artifact_bridge_transfer_cancel accept transfer_id and revalidate account identity and both authorized device IDs. Caller may poll status but never needs to send chunks.

The worker issues bounded 64 KiB Native file reads, validates canonical Base64, creates an exclusive destination staging file, then writes at the exact durable offset. Remote staged size must match before each positioned write. It rehashes source and staged destination with SHA-256 before atomic no-overwrite publish. Exact account and two-device grants and existing Native PathPolicy are preserved. Never claims transfer completed on an UNKNOWN mutation ACK.

## Persisted resume and cancellation

Each transfer has an owner-bound durable state record, full SHA, confirmed offset, source size/mtime and generated private stage path. Metadata writes are fsynced and atomically replaced. Worker has process/host lease, transient cross-instance metadata mutex, and limits four unfinished jobs per account. On restart an explicit start with resume_transfer_id and identical parameters verifies source full SHA, staged length, and staged digest against a bounded source-prefix digest BEFORE continuing. Mutated staging or source blocks publication. Owner PID still alive blocks another Hub instance. A dead worker lease is quarantined after explicit reconciliation; lost response is never blindly replayed.

Cancellation is best-effort: it stops further chunks before the no-overwrite publication phase. Once publishing starts, cancel is rejected. Canceled transfer staging remains quarantined for separate operator cleanup, not automatically deleted.

## Tests and evidence

- QA child #597 exact original test preserved verbatim and run RED before implementation, PASS after.
- Isolated two-WebSocket-Agent plus MCP test: 226,321 bytes in 4 <=64KiB writes with exact file content and SHA-256, one no-overwrite atomic publish. Wrong owner cannot read status; missing destination grant cannot start. MCP cancellation prevents publishing a second fixture.
- Deterministic worker tests: 221 KiB single start; uncertain Agent write ACK reconciled and explicitly resumed by new Hub store instance without duplicate write; foreign account/project/device denied; preexisting destination not overwritten; cancellation through another Hub instance; source replacement rejected; competing live worker lease rejected; same-size forged staged content refused.
- Existing acceptance #596: previous physical Work PC -> Naveax transfers of 221 KiB and 1 MiB already SHA-verified. No claim of newly deployed physical one-call transfer.

## Production blockers

1. Live Agent v1.0.5 has Native file hash/read/write offset ceiling 256 MiB. Existing #08 local store can handle 1 GiB, but physical cross-device worker intentionally fails closed >256 MiB until #05 provides 64-bit native offsets and true append-if-exact-offset CAS.
2. Background processing lives in current Hub process. Hub downtime pauses work; restart requires explicit owner-controlled reconciliation. Multi-host leases, backup, crash-level directory durability and status progress coordination require QA and independent review.
3. Single-request HTTP 413 for inline 221KiB Base64 still exists on current Nexowire /mcp endpoint; this new start request uses no file payload. Any ChatGPT-owned attachment cap cannot be removed from Nexowire code.
4. Stage quarantine TTL/operator cleanup, aggregate byte quota, service capacity, WAN TLS/WSS, cancellation near publish, source-to-destination real canary must be accepted by #05/#06/#11/#16/#00.
5. This is a DRAFT source change, NOT production acceptance. Do not merge or deploy without independent review.
