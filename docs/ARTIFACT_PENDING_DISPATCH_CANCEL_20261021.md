# Nexowire #08: durable reserved versus dispatched Native cancellation

Date: 21 Oct 2026. Child DRAFT of #667, exact base `8cbf5c06dfe7677e38f896f90a8dac63eae04458`. No deployment/main merge.

## Verified exact-head baseline

- #667 GitHub Actions run `39631999739` COMPLETED FAILURE, **6/7 jobs PASS**, Node22 and Node24 PASS. `browser-live` failure is unrelated Windows Job fast-exit output-drain race in `test/windows-job-owner.test.ts:216` iteration 1, not Artifact Bridge.
- Clean #667 HEAD with original #640 (SHA `91f1426f5378bc2eaf3a680a7f7e067f8d4eba73`) five tests unchanged **5/5 PASS**; #641 (SHA `a6906b4f45c3ba285a733dda689f799e696ec2bf`) seven unchanged **7/7 PASS**; original two-Agent MCP E2E PASS.

## Independent newly reproduced source defect

Current `strictlyWrite` writes durable `pending` before awaiting trusted owner grant and monotonic lease checks. A cancel during this pre-dispatch interval wrongly sets MUTATION_UNKNOWN, and then strict worker can invoke Native `writeFenced` even though cancellation was accepted. No actual Native write was yet dispatched. A new Promise-gated test `test/artifact-588-postjournal-predispatch.qa.test.ts` produced **RED on unchanged #667 HEAD** (actual MUTATION_UNKNOWN instead of CANCELLED).

## Source fix

- `pending.dispatched` optional metadata separates **reserved / never sent** (`false`) from **dispatched or potentially dispatched** (`true` or absent in old journal). An old pending record without this flag is conservatively UNKNOWN, never assumed safe.
- Persist `pending.dispatched=false` before authorization/fencing precheck. Just before invoking Native write, use the existing durable per-job compare/update lock to atomically verify RUNNING/requestId/offset and promote to `dispatched=true`. A cancel that wins prior to this transition can settle CANCELLED, clear only never-dispatched pending, and the subsequent worker refuses Native dispatch.
- Any cancel after this transition, or any `bytesConfirmed>0`, retains `MUTATION_UNKNOWN`, pending requestId/epoch/offset/sha and explicit-higher-epoch resume/no-blind-replay. Because the journal transition occurs before the actual syscall, a narrow post-transition/pre-call cancellation is conservatively UNKNOWN.
- This change affects owner file `src/mcp/cross-device-transfer-jobs.ts`; does not alter QA #640/#641 files or other owner implementation.

## Evidence and environment

- New gate test **RED baseline / PASS fixed**. Original #640 **5/5 PASS**, #641 **7/7 PASS**, original MCP two-Agent E2E PASS; combined targeted **14/14 PASS**.
- `npm run typecheck`, `npm run build`, `npm run continuation:check`, and `git diff --check` PASS in the isolated Work PC worktree.
- Wider optional Artifact large-stream local regression was **BLOCKED by low disk / INSUFFICIENT_STORAGE**, not an Artifact worker assertion. During this session C: briefly reached 0 free bytes; final observed free approximately 30MiB. No user data was deleted and no 1GiB physical/staging transfer was attempted.
- Original QA #640/#641 test files were copied temporarily into worktree unchanged for execution and removed before commit. Production no-go remains: #587 independent external monotonic CAS, #05 actual Agent native epoch/offset writer, #610 quota evidence, #613 connection grants/epoch and #16/#00 staging/production acceptance.

**DRAFT source-only; no Agent/Hub/VM restart, real 1GiB file, production deploy, main merge or user-file overwrite.**
