# Capacity arithmetic boundary fix and #1205 portable review (2026-11-19)

Parent #1160 integration SHA: `81028bf643e3dc3cb5b0ab3f9c609c239732a413`.

The offline worker capacity model previously threw while binary-searching an otherwise representable answer: a valid midpoint can exceed JavaScript's maximum safe integer even when a smaller affordable user count exists. Example: max-safe request budget, 10,000 hosted calls/user/day and 10,000 auth Worker requests/tool gives a mathematically exact maximum of 90,071,992 active users. The original binary search throws at the first enormous midpoint. A single user whose request demand already overflows should yield capacity zero, not crash.

The change keeps strict validation of negative/fractional/invalid configuration values through the zero-user estimate. Only the model's own `capacity result must be a non-negative safe integer` arithmetic overflow in the per-user or search-midpoint estimate is interpreted as exceeding the given budget. No hosted quota, billing, side effect or dispatch behavior is changed; this is an offline planning calculation.

The new root test `test/scale-worker-capacity-overflow.test.ts` and local source `src/ops/scale-worker-capacity-model.ts` import only Node `node:test`, `node:assert/strict`, and this one pure local module; they use no filesystem, devices, network, timers or production service. Exact source Git blobs are `5a9e16fb2aad7fd3dbce9ff34989d7affa51664f` and `5d9f122d5df70397f42be758311ad7d35733235a`. Add them to the reviewed pure import graph and portable root list (34 -> 35 files; 27 -> 28 pure entrypoints, 32 -> 33 dependencies). Three regression cases. New tracked TS test file increases inventory total by one; this does not imply the legacy `npm test` glob was fixed or full-suite coverage exists.

Acceptance: source-bound Portable Root and Test Discovery on Node 22/24 plus exact SHA general CI, all must pass. No Windows SYSTEM Hub physical acceptance or stable release inferred.

## Exact BigInt follow-up (supersedes initial workaround)

After the first commit's green portable source tests, an independent BigInt reference check found a second boundary: huge hosted tool invocation counts with zero Worker auth/charge requests can falsely limit the computed worker budget when an intermediate JavaScript number overflows. The search now evaluates billed Worker requests and retry rounding *exactly* in BigInt, without generating unrepresentable intermediate Number metrics. Input checks remain strict; output remains a safe integer. Fixed overhead plus retry exceeding budget returns zero. Five root regression cases replace the earlier three; the previous 190-assertion CI conclusion must not be reused for this new commit.

Current reviewed Git blob test: `d2ba84e59b45ec6973d4177360d7e9fbecebafe4`; source: `0ba30bd7101061f92455b3df10204d91077c43b8`. The API only plans capacity, never allocates users or modifies hosted quota. The full detailed estimator remains bounded by safe Number fields as before.
