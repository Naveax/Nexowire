# #588 Direct MCP 16 MiB opt-in candidate — 2026-11-17

## Change and scope

- Source parent: Draft #1160 integration at `4d44fafd8e68c7a9a5849b38b3026aeb0e38617b`.
- The public `file_transfer_between_devices` schema now accepts an **explicit** `max_bytes` up to **16,777,216 bytes (16 MiB)**. The default remains **8,388,608 bytes (8 MiB)**. The independent helper maximum remains **64 MiB**, with **48 KiB sequential chunks**. No unbounded response body, artificial quota bypass, or new privileged command is introduced.
- The existing source/stage/final destination SHA-256 verification and atomic no-overwrite commit are preserved. Exactly the destination device's final file must be hash-read after commit before reporting `COMPLETE`.
- Existing `docs/delegated/file-ux-k19/ISSUE588_SOURCE_LIMIT_INVENTORY.md` is a *historical source snapshot* of the previous 8 MiB public contract. The current code and source-derived test inventory assert the new 16 MiB opt-in ceiling.

## Reproducible local measurement

- Work-PC Windows, Node `v24.15.0`. This is a **two-simulated-Agent loopback**, with actual MCP tool, local WebSocket, real temporary disk files, per-agent path policies and bounded Agent `files.read/write/hash/move` capabilities, **not two physical computers or a remote provider**.
- 8 MiB baseline, 171 chunks, measured first-transfer elapsed **1,224 ms** (diagnostic run before schema expansion).
- Explicit 16 MiB, 342 chunks, measured first-transfer elapsed **1,806 ms**, then a repeated run measured **1,747 ms**. Source bytes did not appear in the MCP tool response. Final destination SHA-256 readback occurred and was asserted.
- The 16 MiB positive path is now an **automatic regression test** in `test/cross-device-mcp-transfer.e2e.test.ts`. The public schema's minimum and maximum are checked via `listTools()`. Invalid/missing source and existing destination remain negative tests. Source limit inventory's negative test is scoped strictly to the target tool's registration, not coincidentally identical bounds of unrelated tools.
- TypeScript and targeted tests passed locally; hosted exact-head CI must be reviewed separately.

## Limits still open

This is **not** proof of the original ~220 KiB ChatGPT UI/provider error being resolved; no physical second device, loss/reconnect acceptance, latency under WAN, provider request deadline, available quota, actual 256 MiB+1 / 1 GiB file or durable resume was tested. Explicit 16 MiB may still fail in provider environments with tighter timeout/quota limits. Do **not** claim arbitrary-size files, live deployment or issue closure.

No installed Nexowire Agent, running Hub/Broker, production data, Windows SYSTEM task or remote service was changed.
