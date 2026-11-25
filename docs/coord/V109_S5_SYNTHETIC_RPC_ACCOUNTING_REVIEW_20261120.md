# S5 local synthetic RPC outcome accounting regression

Date: 2026-11-20. Parent stacked SHA: `bacd4c992d31538645c4ae6d132cedc4d4cbce1d`.

The offline `summarizeS5ScenarioResults` formatter validated attempted, reserved and backpressure separately, but omitted validation of `duplicate`, `rateLimited` and `other` and did not enforce the producer's explicit identity `attempted = reserved + duplicate + rateLimited + backpressure + other`. Therefore a synthetic report could accept internally contradictory counts and present impossible reservations without a source-level error.

The producer `scripts/bench-s5-loopback-ws-capacity.ts` already asserts this identity for its self-generated records, but the exported summary accepts arbitrary imported `S5LoadResult[]`, so validation must hold at the report boundary too. New guard checks every terminal counter is a nonnegative safe integer and compares the sum using BigInt to avoid floating point loss at exact safe-integer boundaries.

`test/ci/s5-rpc-outcome-accounting.test.ts` covers a valid five-category partition, missing/double-counted categories, nonfinite/unsafe counters, and an exact safe-integer limit. The file is explicitly inside existing `npm test` Bash glob `test/**/*.test.ts` (one-level child `test/ci/`) so Node 22 and Node 24 CI must execute it, unlike historical tests nested two directory levels down. No live socket, SQLite, device, Cloudflare API, native OS action or billing is invoked by the test.

Original report Git blob `89ee1053375b54c968c04dc3001d86936091459b`; production source only changes the read-only report validator, not load runner or runtime authority. No provider capacity, physical SYSTEM cutover, full test-inventory coverage or release acceptance inferred. Exact-head CI must pass before integration.
