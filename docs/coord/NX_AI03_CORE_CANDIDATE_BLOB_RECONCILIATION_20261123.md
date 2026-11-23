# AI-03 CORE console preservation reconciliation, 2026-11-23

This coordinator-only child of Draft #1239 (`40d2cec06f18e74aa66a9ff40a9e88c8a9f48e03`) updates the **current candidate blob SHA** for `src/agent/core-console-admission.ts` in precisely two existing source-preservation CSV rows. The older upstream/historical provenance SHA and every other row remain unchanged. It does not edit test code, browser behavior, authorization, SYSTEM tasks, DPAPI or live devices.

Former recorded candidate: `85b3850a3ebb5a61f6c5416e8cc53f8da7bb7c9a`. Exact verified Git blob of the PR's current source: `0e5c55184a0aef839b58a8f13d576bcf4f6d7aa2`.

Matrices:
- `docs/coord/AI05_CORE_CONNECTION_V2_PRESERVATION.csv`
- `docs/coord/AI05_ROUND2_SOURCE_PRESERVATION.csv`

**Why:** Node 24 `npm run check` on the AI-03 exact-head branch failed existing provenance inspections because the source changed but the candidate entry retained the old SHA. Simply disabling source preservation would be incorrect. This updates the current candidate reference to its verified Git object; historical reference remains for review.

CI is required on this combined commit, and **the previous CI conclusion must not be reused**. The AI-03 standalone source snapshot still requires separate Proxy-trap hardening review. Neither provenance repair nor green CI proves physical native CORE effect, DPAPI, owner consent or stable release. No main/production device mutation.
