# #588: Final destination hash readback — 2026-11-17

## Source change

- Review parent: `ca41c11136f4b4d90feba94992d182289a808990` on the source review branch for #1160.
- After bounded per-chunk reads/writes, initial source SHA-256, temporary-stage SHA-256, and atomic no-overwrite commit, the helper now independently computes SHA-256 **from the final destination path** before returning `COMPLETE`.
- The MCP route uses the destination Agent's existing `files.hash` capability, inside its normal file policy and per-operation size boundary.
- A destination hash mismatch produces `TRANSFER_DESTINATION_HASH_MISMATCH`; a failed/unknown readback produces `TRANSFER_DESTINATION_READBACK_UNAVAILABLE`. Both outcomes fail closed and explicitly indicate that the destination **may already have been published**. Do not blindly retry or erase the destination.
- The helper does not weaken owner scopes, path grants, size ceilings, quotas, no-overwrite semantics, or the source/stage hash checks.

## Acceptance

- 29 focused runtime, file-I/O, MCP and K19 contract tests passed on the Work-PC. Added two post-publish mismatch/unknown test cases and an E2E check requiring exactly one final destination hash readback.
- TypeScript check PASS.
- Source preservation's 79/243/290-row candidate ledgers re-bound to the modified MCP file and their transitive parent Git blobs. Historical source SHAs remain unchanged.
- This proves local source behavior and a two-simulated-Agent MCP loopback, **not** a second physical computer, WAN integrity, independent device hash receipt, or a verified production release.
- Per-call transfer limits remain: public MCP 8 MiB and cross-device helper 64 MiB, distinct from the Artifact Bridge 256 MiB limit. Arbitrarily large resumable transfer remains OPEN under issue #588.
