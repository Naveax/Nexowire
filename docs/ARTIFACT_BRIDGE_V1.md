# Artifact Bridge v1: parallel-08 (experimental)

This feature builds a durable artifact store on the Nexowire Hub filesystem. It does not alter ChatGPT automatic memory, OAuth issuers, Agent operation journals or production devices.

## Storage and authorization

- All data lives under the Hub state directory, artifact-bridge-v1. Hashed account/project/device subdirectories are determined internally. Logical artifact paths are relative names, never paths on the Hub filesystem.
- The account identifier comes from the authenticated MCP principal: hosted control-plane account ID, OIDC issuer and subject digest, or stored credential ID. Static tokens are rejected. The bearer must explicitly authorize the requested origin device. Different stored credentials do not implicitly share artifacts.
- A project ID is pinned to a repository. Every manifest records repository, 40-character Git commit SHA, logical artifact path, SHA-256, origin device, producer operation ID, UTC timestamp and test/acceptance status.
- Important: Git commit, operation ID, test and acceptance values are caller assertions, not independent GitHub, CI or Agent attestations.
- Finalized content is stored under its digest, verified before retrieval, and never reported as available when missing/corrupt. Project checkpoints snapshot exact artifact manifest identities and refuse replacement without explicit re-publication.

## MCP workflow

1. On an explicitly permitted source device, use existing file_stat and file_hash to obtain size and SHA-256.
2. Call artifact_bridge_begin with device_id, project_id, artifact_path, repository, commit_sha, operation_id, size, sha256 and status fields. Same valid content returns ALREADY_PRESENT; otherwise receive session_id and a verified resume offset.
3. Use file_read base64 chunks, and artifact_bridge_put_chunk with session_id and exact byte offset. Decoded chunks must be at most 64 KiB; identical chunk retries are accepted, conflicting ones refused.
4. Call artifact_bridge_commit after all bytes are uploaded. Full-file SHA-256 is verified before an atomic manifest commit. To replace a different existing digest provide expected_previous_sha256 as CAS.
5. Optionally call artifact_bridge_checkpoint_import to copy an explicitly selected pre-existing device/workspace checkpoint into this authenticated project, referencing only independently verified artifacts with matching repository and commit.
6. In any later chat authenticate as the same principal and use artifact_bridge_list and artifact_bridge_checkpoint_list for the same project ID and origin device ID. Use artifact_bridge_get, artifact_bridge_checkpoint_get and artifact_bridge_read_chunk for retrieval. Files can be copied to Work PC using existing permitted file_write, then independently hash-checked.
7. Existing task_artifact_list / task_artifact_verify remain metadata-only discovery/verification tools, not evidence that the actual bytes have been backed up.

These tools are experimental and not added to the frozen MCP v1 stable surface list. Both Hub and MCP plugin must run this new code before they are available. This PR does not deploy them.

## Direct native Agent to Hub ingest

Prefer artifact_bridge_ingest_device_file over manual Base64 transport for sensitive or larger files. Provide an authenticated and explicitly permitted device_id, source_path (checked by Native Agent path policy), project_id, logical artifact_path, repository, commit_sha and operation_id plus optional test/acceptance/CAS fields. The Hub calls native files.stat, files.hash and files.read server-side. All three underlying MCP tool grants/capabilities are required in addition to the composite permission.

File payloads do NOT appear in this tool response. Only state, offset, size and SHA-256 receipt are returned. Each call processes at most 32 chunks (2 MiB), default 16 chunks (1 MiB). Repeat the SAME arguments until COMPLETE or ALREADY_PRESENT; PARTIAL is not success or acceptance. Each call checks the source digest again to detect changed files. Stage corruption blocks transfer rather than silently restarting. The complete stage SHA-256 is verified at commit.

This is an explicitly invoked Hub pull, not an always-on Agent background synchronizer. Testing uses real loopback WebSocket frames with a sandboxed Native Agent, NOT production TLS, WAN connectivity or a hosted account.

## Bounds and security caveats

- Maximum artifact: 256 MiB. Maximum decoded chunk: 64 KiB. Maximum 4096 stored chunks, 128 artifact references per checkpoint.
- A per-scope exclusive lock prevents uncoordinated writers; orphaned locks following a crash intentionally fail closed and require verified operator recovery. An interrupted partial write may make a stage non-resumable if durable offset receipt and stage size differ, rather than claiming an unverified success.
- Explicit authenticated Hub-to-Agent source pulling is supported. This does not provide automatic background sync, multiple-Hub replication, GitHub SHA attestation, independent producer/CI attestation, or cross-device installation without explicit calls.
- The older unscoped workspace_checkpoint tools were not changed for compatibility. The new bridge requires the caller to deliberately import and scope legacy checkpoints.
- Artifact bytes are returned as Base64 to authorized clients on read_chunk. Never retrieve secrets through a chat unless that disclosure is intended.

## Validation

Run npm run typecheck; node --import tsx --test test/artifact-bridge.test.ts; npm run continuation:check; and selected MCP/workspace/task-artifact/cross-device suites. Test scenarios include restart, hash corruption, CAS, duplicate chunks, authorization boundaries, wrong project, same filename across projects, missing files, concurrency and multi-MiB upload.

Keep DRAFT pending CI and security review. No main merge or production deployment in this workstream.
