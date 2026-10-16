# Cross-device file transfer (bounded pilot)

This change introduces `file_transfer_between_devices` as an MCP operation for copying a regular file between **two explicitly selected Nexowire agent devices**. It addresses HTTP 413 errors caused by sending an entire Base64 file through the ChatGPT tool request or response.

## Interface

```json
{
  "source_device_id": "<authorized device id>",
  "destination_device_id": "<authorized different device id>",
  "source_path": "<allowlisted source path>",
  "destination_path": "<allowlisted new destination path>",
  "max_bytes": 8388608,
  "create_parents": false
}
```

- **Source bytes are not included in the final MCP tool response.** The MCP server reads and writes bounded 48 KiB chunks internally.
- The file is checked by SHA-256 before transfer, source SHA-256 is checked again afterward, and the destination staging digest must agree.
- On the destination agent, chunks are written to a randomly named sibling `.nexowire-upload-<UUID>.tmp` file. `files.write` supports `create` (exclusive file creation) and `write_at` (bounded offset writes, no sparse gaps) for this workflow; normal `overwrite` and `append` behavior remains available.
- The final commit is a **same-directory, atomic no-replace hard-link publish** using `files.move` with `atomic_no_overwrite=true`, followed by removal of the stage link. If the destination already exists, publication fails instead of replacing it.
- The source and destination device IDs are authorized independently through Nexowire's existing per-device policy checks. MCP restricted credentials must also allow `file_read`, `file_stat`, `file_hash`, `file_write`, `file_move`, `file_delete` and the composite tool.
- The pilot is bounded to 8 MiB per transfer; the default and maximum are 8 MiB. To raise the limit later, benchmark end-to-end latency, request timeouts and provider quotas first.

## Known limits / cautions

1. This is a **copy-only** operation. It does not remove the source file.
2. Transfers are **not resumable** yet. If a network error occurs during a chunk, the server best-effort deletes the incomplete stage. A disconnected worker can leave an orphaned stage file. The original destination is never overwritten by the atomic commit.
3. A transfer returns a failure if the destination exists. The caller may compare the existing file hash manually before choosing a different destination.
4. Windows NTFS and filesystems supporting regular-file hard links in the same directory are expected. Unsupported filesystems **fail closed** during publication; there is no unsafe check-then-rename fallback.
5. The source is re-hashed before commit to detect modifications. Concurrent hostile writers or filesystem-level corruption are not transactionally excluded: the staged hash check and the source hash check are read-only observations.
6. The hash and move requirements apply to the source/destination agents' existing allowlist and capability policies. No global filesystem access, elevated privilege or desktop permission bypass is implied.
7. The new tool must be deployed to the MCP server **and** the corresponding ranged-read/positioned-write/atomic-publish code to both agents before a real cross-machine transfer will work. Tests in this change use two independent **isolated simulated agent connections**, not live user devices.
8. Do not run on irreplaceable production files before live end-to-end checks on two disposable folders.

## Validation

```bash
npm run typecheck
npm run build
node --test --import tsx test/cross-device-file-transfer.test.ts test/cross-device-agent-file-io.test.ts test/cross-device-mcp-transfer.e2e.test.ts
node --test --import tsx test/mcp-capability-discovery.test.ts test/mcp-auth-aware-discovery.test.ts test/mcp-schema-compat.test.ts
```

Acceptance verifies 220+ KiB transfers without a single large tool payload; zero-byte files; target already exists; corrupt/missing chunks; source changes; staging hash disagreement; bounded file read/write; and authorization gating.

**Status:** Source changes and isolated tests only. No production agent or server was updated by this change.
