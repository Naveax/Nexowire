# Issue #1205: GitHub App manifest pure-suite review (2026-11-19)

Integration parent: `466d40f04c641204c34695d70625053d5635f59f`. This is a source-only CI review of one **previously unreviewed, already tracked** root-level test, not new product functionality.

## Exact source review
- `test/github-app-manifest.test.ts` Git blob `2c6608e65c6b86fc0064edbb9540ffa6143f8a5c`.
- Direct local dependency `src/product/github-app-manifest.ts` Git blob `eaeda3495cd0492df04bd01567a29aeafe80f08e`. No local imports from that dependency. Test imports only Node `node:test`, `node:assert/strict`, and this reviewed local file.
- Three top-level tests: (1) GitHub App manifest has zero requested repository permissions/events, pins HTTPS callbacks and disables automatic install OAuth; (2) manifest exchange injects an in-memory `fetchImpl` and checks that only OAuth identifiers/secrets are retained, not private key or webhook secret; (3) insecure origins and malformed codes reject before conversion. No host network, filesystem write, Windows controls, Agent, Hub or SQLite is exercised by the suite.
- The production method **can** make a GitHub HTTPS request when called without a stub; the *reviewed test* only calls the valid-code path with injected `fetchImpl`, and the invalid-code path rejects before reaching fetch. This narrow distinction matters.
- One new exact file and one dependency are added to the SHA-pinned static pure-import closure. Existing file/blob pins, CLI strictness, and source-bound subprocess/TAP acceptance are unchanged.

## CI acceptance and scope
The curated portable root suite expands **33 -> 34** files; the pure-import-reviewed subgraph expands **26 -> 27** root tests and **31 -> 32** local dependencies. Its 3 additional assertions must pass on both Node 22 and 24 through the existing real subprocess receipt path. This changes neither the Bash glob mis-discovery of 607 paths nor the rule that all remaining files are NOT_REVIEWED until separately examined.

No physical Work-PC, SYSTEM Hub cutover, reboot, privileged Broker, main merge or release publication is performed. Hosted exact-head CI is required before integration.
