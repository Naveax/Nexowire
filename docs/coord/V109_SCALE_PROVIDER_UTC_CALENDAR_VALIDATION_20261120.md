# S5 Cloudflare operator-imported meter evidence: strict UTC calendar check

Integration parent: `06a9df635b6731c02170ca3583ba6de2b8b909dd`, date: 2026-11-20.

The existing `src/ops/scale-s5-provider-meter-evidence.ts` accepts strict-looking ISO 8601 UTC strings but then calls `Date.parse` without verifying that the parsed timestamp represents the same calendar date/time. Node normalizes invalid inputs such as 2026-02-30, 2026-04-31, 2025-02-29 and 24:00 to later dates. This can falsely shift an imported usage-counter sampling window.

**Fix:** after parsing, demand that the canonical `new Date(n).toISOString()` matches the original UTC timestamp exactly, inserting `.000` for inputs without fractional milliseconds. Valid leap days and three-digit fractional milliseconds remain supported. Invalid dates fail closed. This is a read-only imported meter comparison; no provider credentials, real API, live quotas or billing changes.

**Regression:** one added top-level test with invalid calendar examples, a valid leap day and an exact fractional-millisecond time window. Existing provider meter tests remain unchanged. This previously curated pure-root file was already in the allowlist, so the reviewed 35-file count is unchanged, while assertion count increases by one when hosted CI passes.

Exact Git blob updates:
- source `21233e0c7e5dd9a39209bfe6989cab7f02334d79` -> `ffdcf7e513a3eb58a49d008f4c57c580941c95cb`
- test `4950286aea128fa34aa279dfc2cd17a12e190297` -> `995e600846f2d314cedb1bdb571220b13c98868f`

Both values are refreshed in the source-bound `pure-import-provenance.mjs` and `portable-root-execution-receipt.mjs` allowlists. Hosted Node22/24 Portable Root and Test Discovery, plus General CI, are required. No physical Windows SYSTEM Hub acceptance, main promotion or release publication is implied.
