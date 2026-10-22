# Worker #30 | Monotonic publish CAS versus tenant memory/UNKNOWN quota

**2026-10-22 · QA-only DRAFT · source-only · PRODUCTION NO-GO**

## Exact upstream references

- **#766** `4b2f9c1941000a93919913a6e0c06c8008dc35bf`, hosted CI `39803836141`: **Node 22/24 SUCCESS, two new QA cases discovered and PASS**, each emitting `QA30_FINAL_QUOTA_UNKNOWN`. WSL2/macOS/Linux/Security passed; Windows browser-live was still in progress at latest check. The earlier #766 `c9b371...` run failed with a TS1434 source typo; do not erase that history.
- **#768** `00ad9a4f061a4da2a0215e470b302f1e25950e4e` adds trusted *rollback-independent* `commitPublished` and only writes local `COMPLETED` with a valid external `durableCommitId`. Native publisher signed receipt or final full-size hash alone are insufficient.
- **#718 quota owner** `ec3aa818e129dfd4bf7e617930623f67121e6bec`, CI `39803009137` previously running: thorough no-release UNKNOWN/late ACK, revoke/re-pair, stale external CAS, one-time disk refund source negatives. This owner implementation lives **on a different branch** and is NOT imported by #768.
- **#738** `ce85d257c2f005156175a4d14a65ec81565575fc`, CI `39677587592` **7/7 SUCCESS**; #735 `d4c35e2a7adec3b845b03886f314772a65473d63` CI `39735083325` **SUCCESS**. No duplicate parser/tenant stress tests in this child.

## Source-only independent new seam

`test/worker30-monotonic-cas-memory-quota-negative.test.ts` imports the **actual #768 `CrossDeviceTransferJobs`** and **actual existing `StagingArtifactByteBudget` against in-memory SQLite**. Synthetic external publisher, synthetic independent CAS, and an **explicitly test-only** memory escrow support two deterministic modes, no live Native:

1. `lost-native-ack`: an existing destination is published, but the final Native ACK is lost; durable publication `requestId`, SHA and dispatched flag persist; one Native publish, zero external commits; the actual journal remains `MUTATION_UNKNOWN` with original `TRANSFER_PUBLISH_OUTCOME_UNKNOWN`.
2. `externally-committed-final`: the exact authentic-looking publication receipt is verified by the synthetic verifier, a synthetic external `commitPublished` returns matching job/request/epoch/SHA with a `durableCommitId`; actual #768 source becomes `COMPLETED` and invokes only one Native publish and one external commit.
3. **In BOTH modes**, neither an external publish commit ID nor a forged `writerStopped:true,deletionVerified:true` client object is independent signed writer-stop/deletion readback. The deliberately separate test-only memory escrow retains two 64KiB owner-A slots through cancellation and re-pair; old or new stale epoch cannot release them. Quiet owner B retains independent capacity for two slots.
4. Real staging SQLite source retains **two PENDING 64KiB chunks** and **262,144B unreleased staged file capacity**. No automatic quota or storage refund, no trusted physical cleanup and no dynamic production #768↔#718 wiring are claimed.

**Important test limitation**: this negative demonstrates actual #768 journal transitions and SQLite source observations, but the per-tenant 128KiB RAM escrow is synthetic because the production per-tenant native memory lease, immutable writer-stop signer and cross-branch #718 cleanup integration do not exist together in this checkout. It must not be promoted into evidence of live resource reclamation or independently authenticated deletion.

## Real fixed-seed parser p95 / p99 provenance (not rerun)

#738 ran 4 gzip HTTP streams expanding to **9,961,472 decoded JSON bytes each**, **64 tiny identity requests**, fixed seed `0x5a17c0de`, localhost-only source #598:
- **Node22**: tiny N=64 p95/p99 **181.198 / 188.449 ms**, large N=4 p95/p99 **1041.139 / 1041.139 ms**.
- **Node24**: tiny N=64 p95/p99 **192.087 / 194.717 ms**, large N=4 p95/p99 **958.405 / 958.405 ms**.
- Nearest-rank `sorted[ceil(p×N)-1]`, measured from local HTTP request start to consuming complete response, for successful responses only. Four large p95 and p99 both select the slowest request. One CI host sample/seed does not make latency deterministic or a public service SLO.
- #724 independent strict-share fixture (seed `0x30ca5e21`) already measures quiet tenant and noisy quotas under held gzip parsers; #735 verifies release on one witnessed parser close. Repeating them would test no new source invariant.

## Exact CI, acceptance and exclusions

```sh
node --test --import tsx test/worker30-monotonic-cas-memory-quota-negative.test.ts
npm run typecheck
```

Log marker `QA30_MONOTONIC_CAS_QUOTA` reports exact #768 source and #718 owner SHAs, actual final journal state/errorCode, synthetic commit count/ID, Native effect simulation count, real staging SQLite pending/reserved bytes and synthetic memory slots. The PR's **exact head SHA** and each hosted job must be verified separately. The `GITHUB_SHA` of an Actions pull-request checkout is the transient merge SHA and not the source branch HEAD.

**NO-GO:** externally deployed signed Native writer-stop, immutable deletion readback, real anti-rollback CAS, current CORE owner proof, production per-tenant memory integration and cross-PR #718 wiring are not proven. No live Agent/Hub/UAC/Broker, VM, Cloudflare/D1/billing, 101+ authenticated native WSS, physical 1GiB end-to-end hash or paid traffic. Only 1 new QA test + 1 report; no source owner, parser, #718, Windows Job or CI workflow modifications.
