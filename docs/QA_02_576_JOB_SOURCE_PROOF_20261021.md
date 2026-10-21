# QA #02 × Job Objects #03: unchanged negative tests against trusted-source candidate

Date: 21 October 2026. This is a **source-only proof** child branch targeting PR #576, not main or production.

## Exact source composition

- Parent PR [#576](https://github.com/Naveax/Nexowire/pull/576) exact source `91c69f66de88b755309e3c127f23357adcedfb86`. Its `615dcc618e6df7e5ab0d2de2ab5e3b890980a774` commit changes subscription to native Job pipes before kernel assignment attestation; no source ownership is transferred to QA #02.
- Prior QA PR [#599](https://github.com/Naveax/Nexowire/pull/599) exact source `0c24d2acf14b4d10f1f37a9f7072a30799665386`, containing the red Windows regression. Its original `test/qa-02-error-contract-no-replay.test.ts` Git blob remains **`0d6f2d5d35c4c73dbb361c899a1fd04bae301a7c`**, and `test/qa-02-windows-output-ordering.test.ts` Git blob remains **`75b01033445772b5864a19495a2c8d7c211a0524`**. These two QA test files were cherry-picked unchanged, not skipped, rewritten, or weakened.
- Only cherry-pick conflict was `.github/workflows/ci.yml`: keep **all eleven** #576 native Job/helper/security test files in the Windows Job regression command and **append** `test/qa-02-windows-output-ordering.test.ts`. No pre-existing check was dropped.
- QA-specific additive behavior: retain top-level `operationId` and also emit matching `idempotency.operationId` on MCP thrown-error outcomes to reconcile an uncertain mutation, without replay.
- Diff against #576 contains no `src/agent/process-manager.ts`, `src/agent/process-worker.ts`, `src/agent/windows-job-owner.ts`, or `native/windows-job-owner.c` changes. All shared Process Manager and Job trust fixes remain owned by #03.

## Historical failure evidence and unchanged contract

- #582 [run 39416566585](https://github.com/Naveax/Nexowire/actions/runs/39416566585), browser-live: missing stdout before `exited` at iteration 1.
- #597 [run 39468688109](https://github.com/Naveax/Nexowire/actions/runs/39468688109), browser-live: same existing Windows Job test failed at iteration 11; its separate #588 one-call transfer acceptance remained intentionally red.
- #599 [run 39492086789](https://github.com/Naveax/Nexowire/actions/runs/39492086789), browser-live: same original test failed at iteration 5; the additional QA tests themselves passed.
- #572 [run 39284185988](https://github.com/Naveax/Nexowire/actions/runs/39284185988), Windows: durable reattach test timed out on missing `NW_DURABLE_READY`. This is an output-evidence failure, not proof of worker non-start or an upstream OpenAI refusal.
- #576 exact-head [CI run 39492594206](https://github.com/Naveax/Nexowire/actions/runs/39492594206): **7/7 SUCCESS**. #608 exact-head [CI run 39503650650](https://github.com/Naveax/Nexowire/actions/runs/39503650650): **7/7 SUCCESS**; these runs validate their own source SHA only, not this combined QA branch.

The QA tests still reject `exited` before stdout/stderr evidence, invalid sequence order, `lost`/`orphaned` promoted to success, and missing durable status. Lost mutation ACK under synthetic Agent disconnect is `MUTATION_STATE_UNKNOWN`/`unknown` with **one dispatch** even through MCP/Hub re-instantiation. No task-success claim is based only on transport `ok:true`. `PATH_DENIED` remains a scoped Agent permission outcome, `UNAVAILABLE` after ambiguous dispatch requires reconciliation, shell nonzero exit is task failure, and audit unknown never becomes succeeded by guessing.

## Evidence gates

On authorized Work PC using a newly created isolated worktree:
- `npm ci --ignore-scripts --no-audit --no-fund`, `npm run typecheck`, `npm run build` PASS.
- `scripts/build-windows-job-owner.ps1` built the development helper inside this QA worktree.
- Targeted physical Windows Job+durable+Error Contract suite (5 files, including unchanged QA #599 tests and #576 owner fast-exit regression): **33 PASS / 0 FAIL / 0 SKIP**. Exact command uses `node --test --import tsx --test-concurrency=1`.
- Full exact-head GitHub CI for this proof branch **must be checked independently**. The local result does not supersede CI and is not production acceptance.

**Release status:** DRAFT/NO-GO for production, signer/publisher trust, external Job-handle duplication and physical two-device release evidence. No live Agent/Hub/Broker restart; no desktop foreground/input interference; no main merge; no actual OpenAI refusal inference. A green source CI cannot be described as production/trust acceptance.
