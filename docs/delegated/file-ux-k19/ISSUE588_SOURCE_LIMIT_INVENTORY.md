# #588 — Source-derived file-transfer limits (2026-11-07)

This is a **source-code inventory**, not evidence of a successful 220 KB
ChatGPT/desktop transfer. The original physical reproduction and device acceptance
remain **NOT_RUN / OPEN**. These paths represent distinct operations, so their
limits are not interchangeable.

| Boundary | Current source limit | Source of truth |
| --- | ---: | --- |
| Public `file_transfer_between_devices` MCP `max_bytes` | 8 MiB (8,388,608 B) | `src/mcp/create-server.ts` tool-specific input schema |
| Internal cross-device helper file maximum | 64 MiB (67,108,864 B) | `src/mcp/cross-device-file-transfer.ts` `CROSS_DEVICE_MAX_BYTES` |
| Internal cross-device helper default chunk | 48 KiB (49,152 B) | `src/mcp/cross-device-file-transfer.ts` `CROSS_DEVICE_CHUNK_BYTES` |
| Device-to-ArtifactBridge ingest source | 256 MiB (268,435,456 B) | `src/mcp/artifact-bridge-device-ingest.ts` regular-file size guard |
| Device-to-ArtifactBridge ingest chunk | 64 KiB (65,536 B) | `src/mcp/artifact-bridge-device-ingest.ts` read loop |
| Device-to-ArtifactBridge ingest chunks per call | 32 | `src/mcp/artifact-bridge-device-ingest.ts` `maxChunks` guard |
| ArtifactBridge manifest file maximum | 256 MiB (268,435,456 B) | `src/workspace/artifact-bridge.ts` `manifestSchema` |
| ArtifactBridge chunk maximum | 64 KiB (65,536 B) | `src/workspace/artifact-bridge.ts` `chunkSchema` |
| ArtifactBridge manifest chunk count maximum | 4,096 | `src/workspace/artifact-bridge.ts` `sessionSchema` |

The public MCP tool's 8 MiB schema is the effective size cap for that public
entry point, even though the separately reusable helper's upper bound is 64 MiB.
ArtifactBridge's 256 MiB cap is a separate storage/ingest route, **not** a
256 MiB promise for the MCP direct-copy tool. A 220 KiB file is below these
source-defined file-size limits; that does **not** establish that it survives
client-side uploads, network instability, source changes, or device policy.

## Repeatable local evidence

```sh
node --import tsx --test test/delegated/k19/issue588-limits-inventory.test.ts
```

`issue588-limits-inventory.ts` reads implementation files as text. The five
regression checks require exact current numeric results, reject removed or
ambiguous bound declarations, reject unrecognized numeric expressions, and prove
that a changed implementation bound is reflected in the parser result. When a
source limit changes, update this table **after** the tests flag the difference;
never label the real-device incident closed from a static PASS.
