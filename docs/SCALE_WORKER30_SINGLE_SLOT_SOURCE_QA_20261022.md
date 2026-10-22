# NEXOWIRE #30: exact CI comparison + one-slot parser cancellation barrier

**2026-10-22 | Independent QA only | parent #724 | production NO-GO**

## Source provenance, no cross-SHA status borrowing

- #724 `f730943fb2392cbc9b55c11e41750c43802c3482`, exact CI [39659574218](https://github.com/Naveax/Nexowire/actions/runs/39659574218): **6/7 jobs SUCCESS**, Node 22/24 source QA PASS; existing **Windows browser-live Job fast-exit stdout-before-exited regression FAIL**. No skip/retry/test weakening.
- #711 `38dfb89a9a756c42a75ccea9d4a0160067b39110`, exact CI [39659054823](https://github.com/Naveax/Nexowire/actions/runs/39659054823): **7/7 SUCCESS**. Real #598 Express fixed-seed 4×9,961,472 byte full **uncompressed JSON wire** and 64 tiny requests. Source seed `0x5a17c0de`. This tests an important *different* network workload from gzip admission.
- #693 `8b08ede8db29fd9a95abb762b238601def07082d`, CI [39644977870](https://github.com/Naveax/Nexowire/actions/runs/39644977870): **7/7 SUCCESS** with 4 gzip wire requests (9,733B each), each decompressed to 9,961,472 JSON bytes, 90 tiny requests.
- Actual proposed parser remains #598 SHA `cf58e6882e44968698f3f548b353287ba1698747`. This child inherits and imports the source untouched.
- This new child extends #724 with **one test file and this report only**, not its owned source or old tests. Record its new **exact branch HEAD** and CI run separately after opening the DRAFT PR. `GITHUB_SHA` in PR workflows is the merge-checkout SHA, not automatically the branch HEAD.

## Actual Node22/24 source measurements

| Source / metric | Node22 | Node24 |
| --- | ---: | ---: |
| #724 quiet framed identity success N=20 p95 / p99 | 100.374 / 103.753 ms | 75.950 / 92.074 ms |
| #724 noisy framed identity success N=24 p95 / p99 | 107.472 / 118.732 ms | 93.381 / 99.419 ms |
| #724 noisy quota denied N=16 p95 / p99 | 34.350 / 34.350 ms | 28.164 / 28.164 ms |
| #711 64 tiny success p95 / p99 | 324.254 / 333.556 ms | 144.798 / 146.657 ms |
| #711 four full uncompressed large success p95 / p99 | 919.375 / 919.375 ms | 920.751 / 920.751 ms |
| #711 observed RSS growth peak | 208,838,656 B | 187,392,000 B |

All latencies: `performance.now()` immediately before HTTP request to **fully consumed response**, **nearest-rank** after ascending sort, index `ceil(p × N)-1`. Only successful completions in success populations; HTTP 503/429 and cancellation excluded. At N=4, p95=p99=slowest. These measurements use *different* seeds, workload sizes, test shapes and CI host conditions; neither ratio is a valid throughput comparison or production SLA. Seed fixes input, **not** OS jitter.

#724 direct parser source tests proved:
- Four noisy incomplete gzip streams occupy **shared, not tenant-bound** large parser slots.
- Quiet tiny **gzip** and tiny **chunked unknown-length** receive HTTP **503** even with unused logical tenant allowance. Quiet framed identity bypasses and succeeds **20/20**. Busy requests never reach the separate staging ledger.
- After *all four* noisy streams are actually closed, quiet gzip can enter (HTTP 200).
- Two source SQLite chunk receipts remain PENDING, 262,144B staged storage remains charged. A separate **test-only** epoch fencer disallows stale pre-re-pair memory release evidence and the quiet owner keeps isolated logical memory budget. No actual native writer attestation.

## Only missing targeted independent negative addressed here

`test/worker30-single-slot-close-admission.test.ts` drives the **real #598 Express middleware on 127.0.0.1**, not a fake parser:

1. Four partially transmitted noisy gzip requests occupy all slots, proven by a real `server.request` arrival barrier; quiet gzip is rejected 503. A *cancellation intent variable* without a real `ServerResponse.close` leaves 503 unchanged.
2. Destroy only **one** noisy client and await its actual server-side `response.close`. Immediately begin a **partially transmitted quiet gzip**, occupying exactly that newly vacant slot; 3 noisy + 1 quiet held means another quiet gzip must still get 503.
3. With all four occupied again, 16 framed quiet identity requests must return 200, with request-to-consumed-response latency p50/p95/p99 logged (N=16, p95/p99 both maximum).
4. Destroy only the quiet partial gzip client; after verified `response.close`, a fully transmitted quiet gzip can parse with the other three noisy still held. Require HTTP 200, exact decoded byte count and independently computed SHA-256 across generated JSON bytes and route readback.
5. Never conflate parser-stage slot close with *memory reclaimed by V8*, authenticated tenant quota, durable mutation completion, signed external witness or actual physical remote cancellation. This test does **not** assert any of those.

This single-slot transition was **not** distinguished by #724's all-four-close recovery case; it is an independent narrow source regression and does not change parser implementation.

## Hard exclusions

No production HTTP owner edits, schema, installer, artifact source owner files, existing Windows Job tests/workflows or test skips. No paid Cloudflare/D1/billing, actual Hub, Agent, Broker, UAC, VM or ReVoltVPN-Ubuntu-Lab. Zero actual 101+ public authenticated WSS, 1GiB physical file verification, or live remote CAS. Such acceptance remains **NOT TESTED / NO-GO**.

## Reproduce

```sh
node --test --import tsx test/worker30-single-slot-close-admission.test.ts
npm run typecheck
```

Full exact-head CI may remain red on unrelated Windows Job failure; preserve the red and report Node22/24 source test results separately. Never invent measured p95/p99 before successful CI output.
