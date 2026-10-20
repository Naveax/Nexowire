# Native Agent bounded large-file API (PR #553, DRAFT)

## Scope and non-goals

This change owns **Agent file API + MCP argument schemas**, not Cross-Chat
Artifact Bridge storage/transfer (#08). There is intentionally no single
unbounded MCP message and no claim that the existing Agent 1.0.5 installations
already run this code. Each request remains subject to Agent/Hub transport,
authorization, provider routing, idempotency and physical OS constraints.
"Unlimited file size" means **no artificial 220 KiB or 256 MiB total-file
cutoff in the chunked API**, not infinite storage, time, quota or throughput.

Identified source limits before this change:

| Layer | Before | After / semantics |
|---|---:|---|
| Agent/MCP \`files.read\` | 16 MiB max response, 2 MiB default | legacy unchanged; **64 KiB max for offset reads**, default 64 KiB when offset supplied |
| Agent/MCP \`files.read.offset_bytes\` | 256 MiB | safe integer up to \`Number.MAX_SAFE_INTEGER\`, bounds-checked against actual file |
| Agent \`files.write.content\` | 22,369,624 characters | old compatibility limit retained; \`write_at\` additionally ≤64 KiB decoded bytes |
| Agent/MCP \`files.write_at.offset_bytes\` | 256 MiB | safe integer up to \`Number.MAX_SAFE_INTEGER\` with safe \`offset + length\` and no holes |
| Agent/MCP \`files.hash.max_bytes\` | 256 MiB | **explicit maximum** may safely be multi-GiB or up to safe integer; 64 MiB default guard retained |
| MCP \`file_transfer_between_devices\` | 8 MiB UI maximum, 64 MiB lower-level constant | **unchanged**: #08/composite transfer owns this separate workflow |
| Native-Agent filesystem authorization | grant/Volume GUID+disk+partition | **unchanged fail-closed**: real USB and grant-only writes blocked until native atomic handle executor exists |

The perceived ~220 KB ceiling is **not established as an actual Agent-file
total-size limit** by the source. Tool output/relay/UI budgets and dual MCP
structured/text representations can add overhead. The new recommended binary
chunk is 64 KiB raw (up to 87,384 Base64 characters), rather than emitting a
multi-megabyte Base64 blob. Binary content must not be pasted into chat.

## Safe resumable upload protocol

1. Choose an allowed target directory. Create a **unique staging file in the
   same directory** using \`files.write\` \`mode:'create'\`, \`content:''\`.
   Exclusive creation ensures an unrelated existing file is never truncated.
   The stage name is a client-selected opaque suffix, not a shared ownership
   channel or Agent-issued authority token.
2. For chunks up to 65,536 bytes, invoke \`files.write\` with
   \`mode:'write_at'\`, \`encoding:'base64'\`, \`offset_bytes\` and
   \`expected_chunk_sha256\`. Each append has an exact safe integer offset.
   The Agent verifies the opened regular file's identity, accepts only a
   matching previously written prefix, appends only missing bytes, and
   \`FileHandle.sync()\`s before reporting success. Conflicts fail
   \`FILE_CONFLICT\`. Invalid Base64, holes or overflowing offsets deny.
3. After loss of an acknowledgement or ENOSPC, use \`files.stat\` to inspect
   the stage's committed length and **retry the same chunk**. A matching
   complete chunk yields \`replayed:true\`; a partial matching prefix yields
   \`resumedBytes\`. Different bytes never silently overwrite the stage.
   If an in-flight mutation's result is UNKNOWN, reconcile its staged bytes;
   never start the next chunk blindly.
4. Call \`files.hash\` with explicit \`max_bytes\` ≥ the expected total; its
   SHA-256 runs as a bounded stream, not \`readFile\` of the entire file.
5. Publish with \`files.move\`,
   \`atomic_no_overwrite:true\`,
   \`expected_size_bytes:<total>\`,
   \`expected_sha256:<full SHA-256>\`. A mismatched stage fails closed and
   remains resumable; an existing final file is **never overwritten**.
   Within one directory, \`fs.link\` publishes atomically without replacement
   and the source stage is then unlinked. A crash after linking can leave
   the stage alias present but will not produce partial final content.
   Operators must reconcile aliases by inode/hash rather than blindly delete.
6. Download via repeated \`files.read\` with \`offset_bytes\`, \`max_bytes<=65536\`
   and \`encoding:'base64'\`. Check \`bytesRead\`, \`size\`, optional per-chunk
   SHA-256 and final streaming SHA-256. The caller is responsible for assembling
   bytes in its own authorized storage, not the conversation text.

**Safety limitation:** Node pathname checks, \`fs.open\`, \`fs.link\` and stage
hash cannot provide atomic parent-handle-relative Windows TOCTOU protection
against a hostile local junction/volume swap. Publish is atomic *no-replace*
on the filesystem, not a guarantee that a swapped directory points to the
original disk. A genuine signed native handle-relative helper and physical
USB acceptance are mandatory before enabling such mutations on removable
media or grant-only directories. The current Native Agent keeps them denied.
Shell/WSL/unrestricted process execution remains closed in strict Windows
mode. \`PATH_DENIED\` policy refusals remain distinct from OS \`EACCES\`/ \`EPERM\`.

## Synthetic real-byte regression evidence

- 220 KiB and 1 MiB fully initialized, non-sparse binary uploads and
  downloads through actual \`executeCapability\` chunk calls: stage, streaming
  hash, retries, conflicting replay refusal, wrong hash publish refusal,
  final atomic no-overwrite: **PASS**.
- 64-bit-safe offsets, malformed base64, 64 KiB per-request caps, missing
  offsets, gap creation, overflow: **PASS**.
- Write-only resumable replay attempt: `PATH_DENIED`; concurrent different
  chunk writes at the same offset: one success, one `FILE_CONFLICT`, final
  staging bytes intact: **PASS**.
- Simulated disk full after a real 4 KiB partial file write: \`ENOSPC\` does
  **not** create a final file; retry reuses the written prefix and finishes
  the stage; final SHA and publish: **PASS**.
- 320 MiB logical-hole (sparse-like) temporary file: high-offset chunk and
  full SHA-256 streaming: **PASS**. This does not attest the Windows NTFS
  sparse attribute or allocated disk blocks.
- 1 GiB fully written (not a logical hole), actual non-sparse temporary file
  created with bounded 1 MiB fixture buffers: high-offset 64 KiB Agent
  reads, high-offset Agent \`write_at\` append, full SHA-256 streaming and
  verified no-replace publish: **PASS**. The 1 GiB *fixture* was generated
  locally; a 1 GiB multi-thousand-call remote MCP upload was **not**
  performed and should not be claimed.
- Cross-device transfer composite size ceiling is unmodified and outside
  this PR's Agent API scope.

All file mutations in these tests target independently generated temporary
directories; no real USB, user content, firmware, partitioning or disk-format
operation is part of acceptance.

## Still blocking merge / production

1. Authenticated, signed, audited Windows native helper with handle-relative
   traversal, reparse handling, volume-serial and file-ID validation at the
   *actual* mutation, including re-letter, hotplug, revoke and true race tests.
2. Physical local owner consent from installed signed Agent, session identity
   and revocation integration, plus audit of Broker/GUI paths.
3. Any main-branch or exact-head CI regression must be triaged with independent
   Windows and Linux/macOS/WSL evidence.
4. Validate real Hub/Cloudflare/MCP per-request behavior and quotas across
   multi-gigabyte transfers. Source-only testing cannot prove every transport
   accepts a 64 KiB binary chunk.
