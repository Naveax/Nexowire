# Scale v2 P1 | Artifact Byte Quota / Fairness (Issue #588)

2026-10-20. **DEV/STAGING contract only.** This PR changes **no** Artifact Bridge store,
manifest, Hub ingestion/egress, Agent file executor, live Worker, billing, MCP
route or production D1 migration. Chat #08 owns actual store and stream
integration; this is an explicit upstream resource admission interface to be
reviewed together with them. The earlier #554/#561/#566/#581 implementations
remain unchanged.

## Exact staging policy and scope

- **Small per-request chunks remain mandatory: max 65,536 bytes.** No base64
  megamessage, unlimited MCP envelope, unbounded JavaScript Buffer or attempt
  to change a platform-owned attachment cap. Artifact owner may later
  implement a multi-gigabyte file as bounded chunks and server-side resume.
- `src/ops/scale-v2-artifact-byte-budget-staging.ts` uses a disposable
  **trusted host SQLite/WAL** reservation ledger. The server must authenticate
  owner/device/project/session and supply current real available disk space;
  all client-provided ownership or `verified` booleans are untrusted.
- Example staging budgets: **64 MiB global accepted bytes/rolling 60 seconds;
  8 MiB per authenticated owner/rolling 60 seconds; 8 GiB total reserved
  or occupied storage; 2 GiB per owner; 64 MiB minimum disk headroom;
  16 active transfers globally; 2 per owner.** These are test-only,
  subject to deliberate performance and actual disk checks, not customer
  entitlements or promises of guaranteed bandwidth.
- Shared writer `BEGIN IMMEDIATE` + transactional counter reservations
  enforce local atomicity. The constructor refuses policies allowing any
  owner more than 1/4 of the global rolling byte budget, storage quota or
  transfer concurrency. Owner fairness therefore preserves capacity for
  other users against one account **under a trusted, unforgeable owner ID**.
  It does NOT prove bandwidth/CPU/IO fairness in a remote multi-host cluster.
- `begin` reserves the declared **whole-file** byte count against active
  owner/global storage reservations and trusted reported free space, and
  requires headroom. This does not allocate a giant in-memory file. A 1 GiB
  manifest can pass under the sample quota; 1 GiB was **not physically moved**.
  Reservations stay charged after complete while a published object still
  occupies storage. Only a *verified durable deletion receipt* releases them.
- One unique server-issued `rootInvocationId` per account/session establishes
  a single logical operation. `ALREADY_RESERVED` is not a new billed root.
  Chunk `requestId` is globally unique: same request/content during retry
  returns its existing `PENDING` or `CHUNK_ALREADY_COMMITTED`, with no extra
  byte reservation or byte counter; any changed owner/device/project/session,
  offset, length or digest is `DENIED_REPLAY`.
- **Two-phase write:** `stageChunk` reserves up to 64 KiB in a monotonic
  per-owner and global rolling window, emitting `CHUNK_PENDING`. No retry
  causes a second write. The #08-owned store must durably write the bytes,
  re-read/verify exact SHA-256 and return a trusted receipt, then call
  `commitChunk`. A lost ACK or crash leaves the session `PENDING`;
  **no blind retry, no automatic byte refund, no offset advance**. The
  integrator must reconcile against immutable storage state or explicitly
  report UNKNOWN. A real storage failure cannot be turned into success
  by forged client-provided `durableStorageVerified`.
- `finalize` requires all bytes committed plus an independent full-file
  SHA-256/length receipt; no early publish or silent truncation. The source
  identity, source modification, scope grants, stale token checks,
  path traversal/reparse, file deletion, terminal abort/expiry and
  free-space *at the moment of each physical write* remain #08/#05
  integration responsibilities.
- **Byte admission accounting != charged billing or actual egress cost.**
  Rolling admitted bytes may include failed-but-unknown physical writes and
  must not be invoiced as successful sent bytes. Production receipt-based
  charge decisions remain separate from transport ingress MCP requests,
  the authenticated logical tool quota and cloud/host transfer costs.
- No throttling by opening more MCP tunnel connections: the provider's
  **shared tunnel/app 600 MCP requests/minute** remains an entirely separate
  ingress budget that also counts discovery, retries and rejected requests.
  This proposed byte contract cannot refund or bypass provider counted calls.

## Negative acceptance run

`node --test --import tsx test/scale-v2-artifact-byte-budget-staging.test.ts`

The real SQLite file-backed two-writer tests check:
1. 64 KiB chunk admission, 2-phase durable receipts, whole-file hash,
   storage occupied until verified deletion and idempotent finalization;
2. Wrong owner/device/project, changed request SHA or same logical root
   with a second session cannot borrow quota or double-charge;
3. Crashed/ambiguous pending chunks cannot be blindly replayed or
   advanced; no credit for rejected attempts;
4. One owner hits 2 chunks/min before another owner, which keeps its own
   capacity; exact 60-second window expiry;
5. Synthetic 1 GiB file reservation without allocating a giant payload;
   1 GiB single chunk rejected, owner 2 GiB quota enforced;
6. Disk pressure, free-space headroom, per-owner active sessions, storage
   exhaustion and trusted global clock rewind fail closed;
7. All changes are source-only. No actual 221 KiB, 256 MiB+1 or 1 GiB
   device->Hub file transfer, Cloudflare D1 race or artifact publication
   is implied by these tests.

## Source / live / staging / billing acceptance split

| Axis | State | Evidence |
| --- | --- | --- |
| Source budget algorithm | LOCAL TESTED | SQLite staging transactions and negative tests |
| Real physical Agent/Hub transfer >256 MiB | BLOCKED, owned by #08/#05 | Old Agent 1.0.5 not upgraded; actual Artifact Bridge still has 256 MiB source/manifest cap |
| Real distributed Workers/D1 | BLOCKED | Neither Naveax nor work-pc has isolated staging D1 token/account/database/approved Worker URL |
| Multi-owner physical disk/backpressure/soak | NOT_TESTED | No production or staging store integration |
| Real cloud or disk bandwidth cost | NOT_TESTED | No trustworthy Workers/D1 or device cost counters, no authorized spend |
| Production user/payment entitlement | NO_GO | **Live Free 1,000 weighted-credit per UTC month remains unchanged**, future daily 1,000/5,000/10,000 OFF, no checkout/invoice/subscription created |
| Provider MCP payload & ingress limits | UNCHANGED | Per-request chunks, provider 600 requests/minute; no infinite payload |

**Production rollout requires** separate owner-reviewed integration, immutable
chunk/whole-file receipts, actual disk quota/retention and cleanup, multi-owner
fairness across all active senders and workers, mock fault injection and
bounded actual file transfers. If no trusted remote database or auth authority
exists, mark that acceptance `BLOCKED`, not PASS.
