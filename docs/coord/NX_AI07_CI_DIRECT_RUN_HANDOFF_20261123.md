# NX AI-07 | Exact-source K18 CI execution handoff

**Date:** 2026-11-23 (Europe/Istanbul)  
**Repository:** `Naveax/Nexowire`  
**Owner:** AI-07 source-only QA. **Workflow owner:** AI-08 / integration coordinator (review required).  
**AI-07 PR:** #1241  
**Integration base:** `b04bf428dd9cedc1a765d9194c17eb0c80df97c0`  
**Reviewed AI-07 test blob:** `a73b5290829820ca5aa9b5bf35585693af855927`

## Exact verified gap

On AI-07 exact commit `cbaebd97a3d634d98107686077da89275baae60c`:
- General CI `45203203291`: **SUCCESS**, including Node 22 and Node 24 jobs.
- Portable Root `45203203247`: **SUCCESS**.
- Test Discovery Inventory `45203203307`: **SUCCESS**.
- The Node 22/24 CI logs **explicitly run** existing `test/delegated/k18/ingest-ack-loss.test.ts` and `test/delegated/k18/p007-transfer-replay-integrity.test.ts`, but **do not list** `test/delegated/k18/ai07-cross-device-transfer-evidence.test.ts`.
- Therefore the five new cases are **NOT_RUN**, regardless of discovery or unrelated general CI SUCCESS. They are synthetic source assertions, **not physical-device transfer proof**.
- `.github/workflows/ci.yml` uses a provenance-pinned SHA and a fixed 409-test TAP count for delegated source transfer. Editing that workflow or importing tests into the existing suite without updating all dependent provenance/checks is not an acceptable AI-07 shortcut.

## Coordinator/AI-08 implementation proposal

**Do not let AI-07 directly modify `.github/workflows/*`.** After AI-08 review, add an independent, fail-closed, Node22/24 workflow dedicated to exactly this test file on the PR HEAD, or equivalently integrate a narrow source-reviewed step into the AI-08 workflow. The following is a suggested **new workflow file**, not an installed workflow.

Proposed path: `.github/workflows/ai07-k18-source-receipt.yml`.

```yaml
name: AI-07 K18 Source Receipt

on:
  pull_request:
    paths:
      - 'test/delegated/k18/ai07-cross-device-transfer-evidence.test.ts'
      - 'src/workspace/artifact-bridge.ts'
      - 'src/mcp/artifact-bridge-device-ingest.ts'
      - 'src/ops/scale-transport-metrics.ts'
      - 'package-lock.json'
      - '.github/workflows/ai07-k18-source-receipt.yml'
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: ai07-k18-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  ai07-source-receipt:
    name: isolated K18 Node ${{ matrix.node }}
    runs-on: ubuntu-latest
    timeout-minutes: 10
    strategy:
      fail-fast: false
      matrix:
        node: [22, 24]
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha || github.sha }}
          persist-credentials: false

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm

      - name: Confirm immutable PR source and reviewed test blob
        shell: bash
        env:
          EXPECTED_SHA: ${{ github.event.pull_request.head.sha || github.sha }}
          REVIEWED_TEST_BLOB: a73b5290829820ca5aa9b5bf35585693af855927
        run: |
          set -euo pipefail
          test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"
          test "$(git hash-object test/delegated/k18/ai07-cross-device-transfer-evidence.test.ts)" = "$REVIEWED_TEST_BLOB"
          echo "sourceCommitSha=$EXPECTED_SHA"
          echo "reviewedTestBlob=$REVIEWED_TEST_BLOB"
          node --version

      - name: Install exact lockfile dependencies
        run: npm ci

      - name: Execute five AI-07 cases and enforce complete TAP
        shell: bash
        run: |
          set -euo pipefail
          node --test --import tsx --test-reporter=tap --test-concurrency=1 \
            test/delegated/k18/ai07-cross-device-transfer-evidence.test.ts \
            > "$RUNNER_TEMP/ai07-k18.tap"
          cat "$RUNNER_TEMP/ai07-k18.tap"
          node scripts/ci/assert-tap-summary.mjs "$RUNNER_TEMP/ai07-k18.tap" 5
          printf 'SHA=%s TEST_BLOB=%s NODE=%s CASES=5 RESULT=PASS\n' \
            "$(git rev-parse HEAD)" \
            "$(git hash-object test/delegated/k18/ai07-cross-device-transfer-evidence.test.ts)" \
            "$(node --version)"
```

### Acceptance contract

1. Both Node 22 and Node 24 jobs on the same exact immutable PR SHA must finish **SUCCESS**. The result must contain the exact tested path, Git blob, TAP test count `5`, `fail 0`, `skip 0`, and `todo 0`.
2. If any source/module/lockfile changes, restart with a new PR SHA; if the test file changes, **independently re-review** and update the reviewed blob pin. Do not silently accept a new hash.
3. CI must not call a production Hub/Agent, real remote devices, WSS, or privileged Windows tasks. Fixture I/O is restricted to a fresh CI runner temporary directory.
4. This only establishes **synthetic source coverage**. It does not establish physical 221 KiB or >256 MiB success, authenticated receipt, Windows reboot, or stable-release approval.
5. Existing general CI and provenance-pinned matrices remain unchanged; do not create a second active run with the same workflow/SHA/input. Avoid treating a skipped/not-run job as SUCCESS.

## Source-only local reproduction

```bash
npm ci
node --test --import tsx --test-reporter=tap --test-concurrency=1 test/delegated/k18/ai07-cross-device-transfer-evidence.test.ts
```

No complete isolated checkout plus npm dependencies was available in the AI-07 session: the execution environment cannot resolve `github.com` and does not have `tsx` or `zod` installed. Do **not** convert the unexecuted tests to PASS on the basis of static source inspection.

## Operational gate

AI-09 retains exclusive authority to mutate production Windows machines. At this handoff, DESKTOP-ONDD84S was ONLINE and NAVEAX was OFFLINE, both agent 1.0.8. Physical two-PC verification is **NOT_RUN**. Keep #1241 Draft until explicit test receipt and coordinator review.
