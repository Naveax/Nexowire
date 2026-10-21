# Nexowire P1 #30 NEXT: compressed response, fair small-queue, cancel-memory provenance

**2026-10-21 · Source QA / DRAFT / production NO-GO**

## Exact source boundary
- Main observed: `754cc4364822be5fda528f54042fb22a84f19924`.
- Parent source: PR #598, `fix/mcp-http-body-cap-588-20261020`, **`cf58e6882e44968698f3f548b353287ba1698747`**. Tests import this branch's **actual proposed** `src/mcp/http-app.ts`. No owner implementation changes.
- Prior #30 QA: DRAFT PR #649, head `955cf289b4b0375ab37c4bcda82cd8706a414135`. Its exact CI `39628451245`: Node22/24 and other six jobs successful, hosted Windows fast-exit test fails. **Do not skip that red test.**
- This isolated child is **not based on #649**. It proposes fresh tests/docs only onto #598 with no overlap to #649's three added paths.

## Test classification

| Test | What is actually tested | Interpretation |
| --- | --- | --- |
| Encoded response | Actual #598 Express output middleware writes a small gzip wire body that inflates to more than 9.5 MiB. Source currently responds 200 because cap counts wire bytes. | **KNOWN GAP**: source response *wire* cap is not decoded-output cap. Passing observation is NOT decoded safety acceptance. |
| Over-limit encoded wire | A deterministic seeded 1 MiB pseudo-random buffer is gzip-compressed then assembled into >9.5 MiB of encoded wire. The actual #598 output middleware returns 413, `mutation_state=unknown`, `automatically_retryable=false`. | Wire cap observed; **KNOWN GAP**: existing `Content-Encoding: gzip` survives the plain JSON error body. Raw HTTP inspection avoids hiding it through client auto-decompression. |
| Large vs small admission | Four unfinished, **real localhost Node HTTP** POSTs reserve parser slots. Arrival barrier uses real `server.on('request')`, no arbitrary sleep. Eight workers send 64 seeded small POSTs: 40 noisy, 24 quiet. A separate **staging-only** SQLite strict-share ledger maps fixed test-tenant headers to internal principals and permits exactly 20 each, rejects other 24. Fifth large returns 503; after upload teardown large parser recovers. | Proposed parser small-path isolation plus **simulated** tenant fairness. Test headers are not auth; source production does not automatically get per-tenant fairness from this test. |
| Cancel memory throttle | Deterministic per-tenant reference model reserves two 64 KiB slots. Cancel/UNKNOWN keeps reservation. Forged, wrong-owner, stale epoch, missing writer stop, missing durable postcondition deny release. One test-only independently minted witness may release exactly once. | **REFERENCE MODEL ONLY**. #598 parent has no verified external memory-writer fence or per-tenant live memory ledger; production cancellation/release acceptance remains **BLOCKED**. |

## Seed and p95/p99 provenance
- Fixed xorshift32 seed: `0x30ca5e21`, used to shuffle the 40 noisy + 24 quiet request schedule and generate compression bytes. This makes *input order and fixture bytes* reproducible; it does **not** make OS/CI wall-clock latency deterministic.
- `performance.now()` samples start immediately before `fetch()` for each request and end after response JSON has been read.
- Success and 429 rejection distributions are reported **separately**, with nearest rank `ceil(p * N) - 1` on ascending finite nonnegative samples. Only HTTP 200 successes enter success p95/p99.
- Small queue: 64 attempts, 40 accepted, 24 quota-rejected under the *synthetic* 40/min limit, eight concurrent request workers; the four large bodies intentionally remain incomplete during these requests. No real native dispatch or paid provider meters.
- CI log markers: `QA30_NEXT_ENCODED_GAP`, `QA30_NEXT_RESPONSE_HEADER`, `QA30_NEXT_FAIRNESS`, `QA30_NEXT_MEMORY`. They include source-base SHA and runner `GITHUB_SHA` (labeled **workflow checkout SHA**, not falsely identified as pull-request head), seed, sizes, counts and local measured p50/p95/p99. The authoritative head SHA and CI run ID must be recorded separately on the DRAFT PR after GitHub reports them.
- A single short localhost trial **does not constitute a service-level SLO** or prove p95/p99 under production load.

## Deterministic reproduction
```sh
node --test --import tsx test/worker30-next-compressed-fairness-source.test.ts test/worker30-next-memory-cancel-reference.test.ts
npm run typecheck
```
Normal repository CI will run `npm run check` and other jobs on its exact checkout; do not manually rerun an already active identical workflow. Do not skip or neutralize the existing Windows Job fast-exit failure.

## Scope exclusions and hard blockers
- No edit to `src/mcp/http-app.ts`, `src/mcp/http.ts`, owner implementation, any workflow, agent or broker. No live Hub/Agent, UAC, Windows service/ACL, VM, ReVoltVPN-Ubuntu-Lab, Cloudflare D1/billing, tokens or user data.
- Gzip expanded-output gap and stale `Content-Encoding` on 413 are **findings for #598 owner review**, not fixed by QA.
- Actual authorization-bound per-tenant fairness, memory-vs-CPU scheduling, trusted external CAS fencing, truly verified cancellation resource release, 101+ authenticated public native WSS, physical end-to-end 1 GiB transfer and provider usage/cost remain **NOT TESTED / BLOCKED**.
- A passing source-only test or synthetic proof must never be promoted into native Windows high-token, live MCP production, paid-plan throughput or Agent 1.0.5 acceptance.
