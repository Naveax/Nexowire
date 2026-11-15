# Portable root-level test smoke (AI-11, issue #1205)

The old `npm test` Bash pattern omits the 574 test files directly under
`test/` when `globstar` is not enabled. Issue #1205 requires proper OS and
resource classification of all tracked tests before we change the default
test runner.

This is a **bounded first execution lane**, not a blanket "635 tests PASS":

- New hosted `Portable Root Test Smoke` workflow runs only on disposable
  `ubuntu-latest` runners, independently with Node 22 and 24.
- Exactly twenty reviewed root-level files are invoked explicitly:
  `test/version.test.ts`, `test/release-tag.test.ts`,
  `test/ai07-physical-cutover-gate.test.ts`,
  `test/capability-policy.test.ts`,
  `test/device-routing-policy-store.test.ts`,
  `test/agent-protocol.test.ts`,
  `test/product-usage-policy.test.ts`,
  `test/product-transport-policy.test.ts`,
  `test/task-os-sandbox-policy-p07.test.ts`,
  `test/bridge-guardian-policy.test.ts`, and
  `test/product-pairing.test.ts`,
  `test/daily-quota-proposal.test.ts`, and
  `test/product-usage-ledger.test.ts`,
  `test/progress-supervisor.test.ts`,
  `test/guardian-key-enrollment-proof.test.ts`, and
  `test/guardian-signed-receipt.test.ts`,
  `test/private-display-plan.test.ts`, and
  `test/owner-public-wss-p256-migration-proposal.test.ts`,
  `test/agent-request-cache.test.ts`, and
  `test/owner-public-wss-stream-flow-staging.test.ts`.
  The two policy-store suites create and remove **only isolated temporary
  fixture directories** on the disposable GitHub runner. No task, network,
  Broker, CORE, registry or production state is touched.
- It uses `npm ci`, serialized `--test-concurrency=1`, a bounded step timeout,
  no permissions beyond read-only repository contents, and fail-closed source
  and TAP receipt tests that check the allowlist and Git tracked-file inventory.
- The receipt runner executes each approved file in its own real Node subprocess
  with forced TAP output, rejects nonzero/partial/duplicate/skipped/missing
  summaries, and emits one JSON object binding executed file names and Git
  blob IDs to the exact commit SHA and full test inventory SHA-256.
  Hosted PR runs explicitly check out `github.event.pull_request.head.sha`
  instead of the synthetic PR merge commit, and the receipt fails closed when
  Git's checked-out `HEAD` does not match the expected SHA supplied by GitHub.
  This prevents a passing merge-ref receipt from being mislabeled exact PR HEAD.
  The receipt prints to CI logs; it does not write to protected production paths.
- This is a **root-level test execution proof only for the exact twenty files**.
  It does not certify the remaining tracked files, any production Windows
  privilege, or physical SYSTEM cutover.
- Never enlarge this allowlist without reviewing imported modules, side effects,
  resource budgets and runner isolation. Windows protected-task tests remain
  in dedicated hosted Windows CI with the real visibility NO-GO checks.

Locally inspect the plan without running broad side-effectful tests:

```sh
node scripts/ci/test-inventory.mjs --json
node --test test/ci/portable-root-smoke-contract.test.mjs
node --test test/ci/portable-root-execution-receipt.test.mjs
```

Full execution coverage stays OPEN under #1205. Do not treat absent tests as
green, silently skip failures or change CORE/STOP or protected production state
to satisfy a suite.

## Hosted TAP execution + immutable inventory reconciliation

The hosted Node 22/24 Portable Root Test Smoke workflow executes
`scripts/ci/portable-root-coverage-gate.mjs --json`. This invokes the existing
exact-reviewed-file TAP runner and the independently tested immutable Git
inventory reconciler within one fail-closed job. The output preserves the
per-file TAP receipt, Git blob SHA, source HEAD SHA, full inventory manifest
SHA-256, and **all** explicitly NOT_RUN test paths. CI runs its negative
contracts before this bounded step.

To repeat the same read-only check locally:

```powershell
$env:NEXOWIRE_EXPECTED_COMMIT_SHA = (git rev-parse HEAD).Trim()
node --test test/ci/portable-root-coverage-gate.test.mjs
node scripts/ci/portable-root-coverage-gate.mjs --json
```

Only the twenty reviewed portable root files are executed. There is no
automatic promotion of unreviewed files, no broad npm-test invocation, no
privileged Windows action, and no assertion that physical SYSTEM cutover
or all tracked files have passed. A coverage count is not authorization.

Two additional pure suites were source-reviewed: agent-protocol and
product-usage-policy. They import static Zod/protocol/capability schemas and
pure product plan/usage policy functions, respectively; they do not invoke
filesystem, process, network, Windows tasks, privileged Broker or production
state. Their exact committed Git blobs are separately pinned by the planner.

## Exact Git source provenance for fifteen pure contract suites

Before the hosted runner executes the portable-root receipt, it runs
`pure-import-provenance.mjs --json` and its negative tests. This gate checks
fifteen independently reviewed test files: agent-protocol, product-usage-policy,
product-transport-policy, task-os-sandbox-policy-p07, bridge-guardian-policy,
product-pairing, daily-quota-proposal, product-usage-ledger, progress-supervisor, guardian-key-enrollment-proof, guardian-signed-receipt, private-display-plan, owner-public-wss-p256-migration-proposal, agent-request-cache, and owner-public-wss-stream-flow-staging; plus all nineteen source modules reachable by
their static local imports. It ties each committed regular file and each
working copy to an explicitly reviewed Git blob SHA and validates the
direct and transitive **local static** import graph with the TypeScript
parser. New local imports, unexpected external package names, changes
to reviewed source blobs, and runtime `require`, `eval`, or dynamic
`import()` in reviewed local files fail closed.

Direct external imports are constrained to `node:test`,
`node:assert/strict`, `node:crypto`, and `zod`; the packages' own implementations and
possible runtime-generated code are **not** independently attested by
this gate. `npm ci` supplies the lockfile-installed dependencies.

Example of a read-only local check:

```powershell
$env:NEXOWIRE_EXPECTED_COMMIT_SHA = (git rev-parse HEAD).Trim()
node --test test/ci/pure-import-provenance.test.mjs
node scripts/ci/pure-import-provenance.mjs --json
```

Source re-review is required before updating a pinned hash. This step
does not review the other five portable suites, grant CORE authority,
approve SYSTEM runtime, or prove end-to-end production safety.

### Transport and sandbox source-only contracts

Two new suites: product-transport-policy and task-os-sandbox-policy-p07.
The former tests direct-first and prepaid-only cost routing; the latter
tests fail-closed source-only sandbox evaluation without an OS executor.
Both suites and their imported source modules are Git-blob-pinned.
No live network, protected task, Broker, CORE or production state is used.

### Bridge Guardian and pairing contract suites

The additional suites bridge-guardian-policy and product-pairing test only
in-memory policy decisions, schema validation, and random pairing token
generation/consumption. The Guardian test never issues a protected task
command or consumes a live privileged verification receipt. The pairing test
does not contact an Agent or disclose a live device secret; it uses generated
test values in memory. The two test files and their three transitively imported
local source modules are pinned to exact Git blobs. The Node built-in crypto
module is the only newly permitted external runtime import.

Neither test grants an OS effect admission or physical Windows acceptance.

### Daily quota simulation and pure usage ledger

Two pure root suites were reviewed: daily-quota-proposal and
product-usage-ledger. The proposed quota simulator uses deterministic
in-memory account/invocation counters; it is not a live billing or
entitlement authority. The usage ledger verifies free, prepaid and
paid charging decisions on isolated in-memory state, without a network
or production account. Both tests and their two new pure source modules
are pinned by exact Git blobs and transitive local import closure.

All 615 other tracked TypeScript tests remain unreviewed after the exact
20-file lane passes. Static review and source CI cannot authorize protected
Windows tasks, CORE effects, DPAPI migration, SQLite cutover or reboot.

### Guardian cryptographic evidence and progress supervisor contracts

Three reviewed suites exercise only isolated in-memory behavior:
progress-supervisor, guardian-key-enrollment-proof, and guardian-signed-receipt.
The Guardian tests create disposable Ed25519 keys in the test process and
verify canonical signatures, one-time enrollment challenges, time bounds,
and fail-closed receipt validity. They do not enroll a live Guardian,
alter a protected task, or grant Broker authority. Progress tests use
synthetic timestamps and stdout records, never real process execution.
All three test blobs and their three new local source modules are pinned
to Git blob SHA and included in static local import closure.

This does not attest third-party crypto implementation or authorize
physical Windows task/DPAPI/SQLite cutover under #1161.

### Read-only display planning and proposed P-256 migration proof

Two additional pure suites exercise only source-only contracts:
private-display-plan and owner-public-wss-p256-migration-proposal.
The first computes a virtual display layout without provisioning any OS
monitor or modifying host display settings. The second generates test-only
Ed25519 and P-256 keys in memory and validates a proposed signed key-rotation
transcript without affecting live operator trust, enrollment, or device
authentication. Both tests and their three additional imported local source
modules are pinned to exact Git blobs; existing capability definitions
remain included under their previously reviewed pinned blob.

This is not a live WSS connection, operator ownership attestation,
physical display provisioning proof or Windows SYSTEM acceptance.

### In-memory Agent request cache and bounded owner WSS stream flow

Two additional reviewed root suites exercise only synthetic dependencies:
`agent-request-cache.test.ts` verifies idempotent request fingerprints,
scope binding, TTL expiry, and same-ID mismatches without touching Agent state.
`owner-public-wss-stream-flow-staging.test.ts` uses a virtual source,
bounded Uint8Array chunks and an injected in-memory acknowledgment/receipt
harness. Its 1 GiB case is virtual and does not allocate an actual 1 GiB
buffer, connect to WSS, write files, or grant a real stream capability.
Both suites and their two local imported modules have exact Git blob pins.

The proposed 20-file receipt is 20 of 635 tracked TypeScript test files;
615 remain NOT_RUN and NOT_APPROVED. Full review and Windows SYSTEM
acceptance remain separate open gates.
