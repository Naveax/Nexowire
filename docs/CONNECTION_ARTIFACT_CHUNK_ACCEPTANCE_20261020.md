# Connection Core v2 / Artifact Bridge chunk fault acceptance — 2026-10-20

**Scope:** test-only transport/fault-injector contribution from Connection Core owner to
#08 Artifact Bridge owner. No edits to ArtifactBridgeStore, source ingest implementation,
production adapters, or real user files. PR #547, #569, #580 and #584 are now MERGED. This separate Connection Core test follow-up must retain its own exact-head CI.

## Exact source and hardware boundary

- Original Connection Core / Journal source base: `cb819d17ee581093d39626f13e985976def17f30`.
- Follow-up exact main base: `af0e0e6149be696837038875f463d23af59b80c6`. New isolated worktree/branch `test/connection-artifact-resume-20261020`.
- Prior PR #580 HEAD `c25b1f83585c5363653b28c920bb34b9b7e525f0`;
  its **old exact-head CI SUCCESS** cannot prove any later test additions.
- Two physical devices (independent `machine.health` RPC over existing v1.0.5 Agent):
  - Naveax: Windows build 22631, 2026-10-20T10:51:20.525Z, PASS.
  - Work PC: Windows build 19045, 2026-10-20T10:51:23.049Z, PASS.
- Both returned as online Agent version **1.0.5**. No deployment SHA,
  live new Hub protocol, running v2 reconciliation or uninterrupted reconnection
  epoch was attested.
- **No physical WAN/LAN interruption, service restart, real Agent file access,
  token rotation, live producer mutation, DNS/firewall/Tailscale/Cloudflare changes**.
- All fixture payload bytes and chunk staging are synthetic and stored only in
  a disposable OS temporary directory cleaned by the test runner.

## Cross-owner API boundary

The existing `src/mcp/artifact-bridge-device-ingest.ts` implements an authorized
server-side read path via `ArtifactSourceOps`, with 64 KiB read/chunk frames,
max 32 chunks per call, exact offset CAS, full SHA-256 source checking and a
**256 MiB maximum source size**. This proves the **old perceived ~220 KiB
per-operation limit need not be the total file cap**; it does NOT establish
infinite/size-unbounded single-file ingestion, universal production file access
or guaranteed capacity. There are still explicit safety bounds.

The Connection Core owner supplies a separate **test-only source adapter**.
`test/connection-artifact-chunk-faults.test.ts` creates a synthetic source
behind a localhost (127.0.0.1, ephemeral port) `ws://` reader and calls the
unchanged `ingestDeviceArtifact` + `ArtifactBridgeStore`. It requires a
mock exact device header and fake test credential; this is NOT a production
authentication implementation or a public WSS/TLS session. The test reader
matches every wire result to an exact in-flight request UUID; stale frames
with a different UUID cannot be accepted.

## Fault matrix / measured assertions

| Case | Isolated result | Evidence |
| --- | --- | --- |
| Source payload larger than 220 KiB | **PASS**, 512 KiB + 37 bytes | deterministic Buffer fixture |
| Bounded read chunk | **PASS**, 65,536 bytes maximum per frame | mock source validates request size |
| Disconnect after crossing 220 KiB | **PASS**, drop the fifth 64 KiB read after four committed chunks | source socket `terminate()` |
| Persist exact uploaded prefix | **PASS**, 262,144 bytes | first four offsets 0, 65536, 131072, 196608 |
| Reconstruct store instance and reconnect reader | **PASS**, second source reads first at offset 262,144 | fresh `ArtifactBridgeStore`, new socket |
| No replay of confirmed prefix | **PASS**, only remaining 262,181 bytes transferred after resume | summed `transferredBytes` |
| Late/wrong response requestId | **PASS**, ignored before the matching response | injected mismatched UUID frame before each valid frame |
| Full-file post-resume digest | **PASS**, SHA-256 matched source manifest and verified readback | `store.get()` / `store.readChunk()` |
| Subsequent re-ingest | **PASS**, `ALREADY_PRESENT` and zero transferred bytes | test assertion |
| Source SHA mismatch after interrupted transfer | **PASS**, no manifest published; eventually rejects mismatched content | second isolated test |
| Simultaneous two real devices transferring | **NOT TESTED** | physical Agent 1.0.5 only read-only |
| Real Hub restart or Cloudflare timeout | **NOT TESTED** | needs #08 staging |
| 256 MiB+ / unlimited per file | **NOT SUPPORTED by current ingest API** | source size check |

## Regression / reproducibility

Run under isolated development worktree with Node dependencies installed:

```powershell
npm run typecheck
npm run build
node --test --import tsx test/connection-artifact-chunk-faults.test.ts
node --test --import tsx test/artifact-bridge-device-ingest.test.ts test/artifact-bridge.test.ts test/artifact-bridge-mcp.test.ts
```

At the first targeted run, TypeScript typecheck PASS, build PASS,
**119/119** combined Connection Core, Agent Journal v2, and Artifact Bridge
focused tests PASS. Results reflect source + staging simulation, never
physical production continuity.

## #08 owner handoff

Owner: #08 Artifact Bridge, whose merged work includes PR #552, #573 and #584.
PR #584 has merged and owns verified-read / TOCTOU source changes. The present test-only handoff is coordinated in that PR's discussion without modifying the owner files.
This Connection Core branch changes **test and documentation only** for
the transfer boundary. Please adopt the harness for staged Agent/Hub
reconnect/offset CAS, duplicate pending ACK, crossed device grants, crash
recovery, terminal SHA-256 verification, and storage read integrity.
Any durable store implementation change or 256 MiB ceiling modification
belongs to #08 and #553 security review, not this branch.

The new injector does NOT prove a live 100% reliable or unlimited transfer.
No postulated full-size memory buffering or unconstrained network writes
may replace strict persisted prefix hashes, authorization, total-size
limits, resource budgets, and user-data protection.

## Connection Core / Journal remaining gates

Current v1.0.5 deployments cannot attest v2 reconnect epoch or durable
Journal. PR #580's adapter is source-only and not in a trusted Hub runtime;
the separate Agent journal's device provenance must come from an
authenticated exact-device route. Already-open token revocation, true
physical two-device reconnect, reliable anti-rollback anchor (PR #582),
independently checked mutation side effects and a signed staged version
rollout are NOT accepted. For `MUTATION_STATE_UNKNOWN`, never automatically
replay a mutation and never claim an OS side effect from an Agent journal
`succeeded` entry alone.
