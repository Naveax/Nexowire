# NEXOWIRE P1 WORKER #30: bounded load and fairness QA (2026-10-21)

**Status: source QA only / production NO-GO / no hosted, paid or native validation.**

## Provenance and dependency

- Repository: `Naveax/Nexowire`.
- Verified main when started: `754cc4364822be5fda528f54042fb22a84f19924`.
- Isolated QA branch: `qa/worker30-bounded-parser-fairness-20261021`, deliberately **based on PR #598 exact parent `cf58e6882e44968698f3f548b353287ba1698747`** so the test imports the **actual proposed** `src/mcp/http-app.ts`, without copying or editing it. Target PR base: `fix/mcp-http-body-cap-588-20261020`; do not merge these tests onto main before #598 is integrated or rebased.
- Related source: #615 and child #628 protect bounded local HTTP and logical tenant fairness; #596 adds source-only 64KiB Artifact Bridge transfer. Their PR CI results do not prove this branch's exact SHA.
- Only newly added files: `test/worker30-mcp-parser-admission.test.ts`, `test/worker30-staging-tenant-byte-qa.test.ts`, and this report.

## Exact test commands after installing normal repo dev dependencies

```sh
node --test --import tsx test/worker30-mcp-parser-admission.test.ts test/worker30-staging-tenant-byte-qa.test.ts
npm run typecheck
```

The test runner inherits Node >=22 from the repository. All TCP traffic is restricted to `127.0.0.1`. The only inflated gzip fixture is about 10 MiB in RAM, not a 1 GiB file or a production upload. SQLite databases in these tests are `:memory:` only. No live Agent, Hub, elevated Broker, UAC, external WSS, D1, paid billing, or ReVoltVPN-Ubuntu-Lab activity.

## Assertions and evidence class

| Gate | Test mechanism | Evidence level |
| --- | --- | --- |
| Four large/unknown-body parsers plus concurrent small MCP JSON | Four incomplete real loopback POST bodies; wait for server `request` events (no sleep); eight small framed requests must return 200; fifth 221 KiB body returns 503 | Actual proposed #598 Express parser; localhost only |
| Compressed small-wire request while large parsers saturated | A tiny gzip-encoded JSON body must return `MCP_JSON_PARSER_BUSY` 503, even though wire length is below 100 KiB | Actual proposed #598 Express parser; localhost only |
| Compression expansion bomb | A tiny gzip-encoded approximately 9.5 MiB+ JSON body is rejected 413; a 1 MiB gzip JSON body succeeds; small request afterwards still works | Actual proposed #598 Express inflation limit; localhost only |
| Fairness under noisy neighbor | `ProposedS5ProtectedTenantAdmission` 40/min logical share, 40 noisy attempts and 20 quiet; strict 20/20 fair split; duplicate/collision/unknown tenant rejected | Actual *staging-only* SQLite class, not provider admission |
| Per-owner concurrent reservations and chunk byte throttle | `StagingArtifactByteBudget`: third noisy reservation denied while quiet owner progresses; 64 KiB chunk bound, pending request / duplicate / offset / forged SHA negative cases | Actual *staging-only* SQLite class |
| Cancel/disconnect during pending chunk | Pending DB reservation retained; no refund/second chunk/replay; quiet owner still progresses. The #598 parent does **not** have a trustworthy durable writer-fence cancellation API | SOURCE negative proxy only; real cancel proof BLOCKED until later main fencing is integrated |
| Rolling 64 KiB receipt arithmetic beyond 256 MiB | 4097 synthetic offset increments as bigint; metadata digests only | Metadata arithmetic, **zero** file bytes or native writes |
| p95 / p99 provenance | Deterministic nearest-rank from only successful samples, `ceil(p*N)-1`; rejected/cancelled excluded; N=4 p95 and p99 select the maximum; separate eight local request timing samples | Test-local `performance.now()` only; **no provider latency SLO** |

## Rollout/CI gates

1. The branch must pass exact-head `typecheck` and the two focused tests; record actual GitHub Actions run **for this exact SHA**, not #615/#628 status or an older #598 run.
2. #598 current parent CI and ownership must be assessed independently. Source parser tests cannot prove production is running that module. Its 9.5 MiB cap remains **proposed** while #598 is DRAFT.
3. The current PR #598 parent predates later main cancellation/writer-fence source; rebase/integrate before treating `CANCEL_PENDING` semantics as proved. No unknown result auto-replay or byte credit.
4. Full cross-Hub fairness, external trusted CAS, authenticated 101+ native WSS, true native tool completion, physical 1 GiB two-device transfer, 24h soak, Cloudflare D1/provider billing and paid staging are **NOT TESTED / BLOCKED**. No fabricated production performance counters.
5. The QA branch must remain **DRAFT** and carry **no production/config/billing modifications**.

## Interpretation

Passing these tests demonstrates deterministic rejection/isolation by particular source modules (plus one explicitly synthetic metadata arithmetic proof). It does not demonstrate a paid-tier capacity guarantee, a production WSS admission limit, exact 1 GiB end-to-end availability, real cancellation after network failure, or that every Cloudflare tenant has a durable external quota fence.
