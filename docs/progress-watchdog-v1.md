# Progress Proof and Supervisor Watchdog (v1)

## Problem and trust boundaries

An alive PID, an open websocket, or an Agent `process.start` response is **not** evidence that model evaluation is advancing. Nexowire now attaches `progress` to native `process.start`, `process.read` and `process.list` results, while `task.graph.get` and `runbook.get` summarize their **own** persisted jobs or steps. The latter are not model counters. No percentages are inferred.

Managed processes opt in by emitting bounded, newline-terminated structured stdout records:

```text
NEXOWIRE_PROGRESS_V1 {"completed_count":12,"pending_count":88,"failure_count":1,"heartbeat":true,"result_artifact_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
```

- Required: nonnegative safe-integer `completed_count`, `pending_count`, and `failure_count`.
- Optional: 64-character lowercase SHA-256 hex `result_artifact_sha256`, `heartbeat`, `diagnosis` (`rate_limited`, `waiting_network`, `cpu_saturated`, `gpu_saturated`, `worker_blocked`, `worker_crashed`, `none`).
- Strict JSON object: extraneous fields, negative numbers, fractional counters, oversized lines, non-monotonic completed/failure counters and invalid JSON are rejected. A partial newline split over Node stdout chunks is buffered, with a hard 8192-byte fragment bound. Even a multi-megabyte stdout event is scanned by newline offset without copying/splitting the entire event into arrays; oversized lines are discarded until the next newline, and subsequent valid records can recover.
- The Agent timestamps observations with its own clock. A worker cannot assert fresh heartbeat time by forging a timestamp in JSON. `lastReportedProgressAt` updates only on an increase in completed count.
- Application-provided counters and result hashes are **self reports**, not independently validated completion. `progressVerified=false` and `lastVerifiedProgressAt=null` remain explicit for process telemetry, even when the worker reports `pending_count:0`. Exit 0 with no telemetry, with unknown exit code, or with pending work is `incomplete`. Only exit 0 with zero pending and zero reported failures is `reported_complete`, not an assertion of verified artifacts.
- Task graph and runbook summaries report their own persisted job/step counts, plus `lastRecordedJobCompletionAt` or `lastRecordedStepCompletionAt`; neither claims `lastVerifiedProgressAt`. Cached hashes are provided only as `artifactHashSource: captured_at_job_finish_requires_reverify`. Use `task.artifact.verify` before relying on a file, because a graph checkpoint or hash can be stale or refer to a missing artifact.

## Watchdog

- Agent checks recorded sessions every 5 seconds. Default stall threshold: 30 seconds after no advancement in `completed_count` with pending work. It detects a growing queue and separates `QUEUE_GROWING_WITHOUT_COMPLETIONS` from `NO_COMPLETIONS`. Stalled completion counters take precedence over a worker-reported rate-limit or resource blocker, so the worker cannot suppress a stuck warning merely by repeatedly claiming a blocker; the worker-reported diagnosis remains attached to the warning.
- Independent conditions include stale heartbeat, no stdout, exited worker with pending work, crashed exit, malformed telemetry, and an explicitly **worker-reported** rate limit, network wait, CPU/GPU saturation, or blocked worker.
- These are warnings, not causal proof. `deadlock` is not asserted without a separate diagnostic. CPU/GPU and network diagnoses are never fabricated from PID status. Inspect host health, worker logs, rate-limit headers and network probes to distinguish causes.
- The warning carries `sessionId`, `code`, `at`, `certainty`, `diagnosis`, `restartAllowed:false` and an action. Warnings are emitted through the existing Agent event channel as `progress.watchdog.warning`, de-duplicated per condition, without launching new user jobs. The periodic scan checks that the Hub WebSocket is open **before** consuming a warning; when offline, the pending warning remains observable after reconnect (best effort, not proof of Hub delivery). Process status is reconciled from the Process Manager on reads and scans, so missing `process.exited` events do not fabricate process liveness.
- The supervisor retains at most 1000 small records, even when output is unbounded. Terminal sessions are evicted first when capacity is needed; active jobs are never killed to make room. After Agent restart, recovered sessions have `progress_unknown` until new telemetry arrives (their old stdout measurements are not silently reconstructed).

## Retry policy and ownership

The watchdog does not execute retries, `process.stop`, `task.graph.run`, or a script restart. `evaluateRetryPolicy` allows an **explicit external orchestration decision** only if:

1. Owner approval is present.
2. The previous process termination and external side effects are reconciled.
3. Operation is marked read-only or provably idempotent.
4. At least one retry remains in an explicit bounded budget.

Unknown or side-effecting operations are never automatically replayed. Process-tree ownership and termination remain in Process Manager #541/#03; this feature does not modify `src/agent/process-manager.ts` or `src/agent/process-worker.ts`.

## Verification and limitations

- Synthetic 10 / 100 / 1000 worker tests verify counters, bounded session storage and no fabricated proof.
- Test cases cover missing/invalid telemetry, split chunks, multi-megabyte stdout, monotonically increasing counters, stalled and growing queues, blocker reports, crashed workers, unknown-exit outcomes, Process Manager reconciliation, incomplete zero-exit tasks, graph/runbook proof levels and retry-budget decisions.
- A controlled local `process.start/read` fixture tests live stdout ingestion without starting trading bots, models or external user scripts.
- Not yet covered: verified on-disk application result manifests bound to a specific account/device/project, long-duration independent live worker acceptance, standalone restart-safe telemetry persistence, and host resource-sampler correlation. These require separate acceptance work; no production acceptance is claimed.


## v2: independent result-file verification (PR #550 continuation)

A live PID, exit code 0, heartbeat, self-reported completed/pending/failure
counters, or a worker-supplied SHA-256 digest are NOT verification. This
continuation adds a separate bounded verifier in
`src/agent/progress-proof-verifier.ts`, a supervisor-only
`verifySessionFromDisk(sessionId, trustedRequest)` entry point, and an
operator-only offline command. **No Process Manager changes.**

### Trusted scope and on-disk format

The trusted caller, NOT the worker's stdout, must independently establish
account, device, project, run, session, immutable task total and the results
root:

```json
{
  "runRoot": "ABSOLUTE_OPERATOR_TRUSTED_TEST_DIRECTORY",
  "scope": {
    "ownerAccountId": "owner-fixture",
    "deviceId": "device-fixture",
    "projectId": "project-fixture",
    "runId": "run-fixture",
    "sessionId": "session-fixture"
  },
  "expectedCount": 2
}
```

Within the root, a `manifest.json` must contain:

```json
{
  "schemaVersion": 1,
  "scope": {
    "ownerAccountId": "owner-fixture",
    "deviceId": "device-fixture",
    "projectId": "project-fixture",
    "runId": "run-fixture",
    "sessionId": "session-fixture"
  },
  "expectedCount": 2,
  "sealed": true,
  "artifacts": [
    {
      "itemId": "unit-0",
      "filename": "unit-0.json",
      "sha256": "SHA256_OF_THE_EXACT_BYTES"
    }
  ]
}
```

Each `results/<filename>` must be a bounded JSON object with
`schemaVersion:1`, `runId`, `itemId`, `outcome: completed|failed`
and optionally `payload`. The verifier reads each physical file, hashes the
actual bytes, rejects mismatched hashes, file/manifest identity drift,
duplicate items/filenames, symlinks, junction-like nonordinary directories,
hardlinks, missing paths and concurrent metadata changes. Limits: 1000
items, 128 KiB per result, 256 KiB manifest, 16 MiB combined. It re-reads
the manifest to detect mutation during inspection.

The verifier computes completed and failure counts from actual result JSON
outcomes, pending from the **independently pinned** expected total, and an
aggregate digest:

```text
SHA256("NEXOWIRE_RESULT_SET_V1\n" +
       each item sorted by id: JSON.stringify([itemId,outcome,fileSha256]) + "\n")
```

The worker's reported aggregate SHA-256, completed/pending/failed counters
and Agent-observed progress time must agree with the scanned evidence.
The last progress timestamp is the Agent clock when the claimed count first
advanced, NOT a worker timestamp. If a result file's observed mtime is
significantly later than that claim, verification fails. Filesystem mtime is
only an untrusted consistency hint, not a trustworthy completion clock.
`lastVerifiedProgressAt` records the Agent's independent rehash time.

### State / safety contract

- `progress_unknown`: no trusted sample or proof, or proof unavailable.
- `active`: running worker with reported counters, possibly separately
  verified files; **never** implies task success.
- `stalled`: no reported completed-count advancement with pending work for
  the configured threshold. Queue growth has its own warning.
- `progress_mismatch`: an explicitly attempted independent verification
  failed (for example false counters, changed file hash, identity drift).
- `reported_complete`: exited 0 and worker reports zero pending, but lacks
  fresh independent proof.
- `completed_verified`: **only** exited 0 with matching trusted scope,
  independently rehashed exact result files, sealed expected count,
  zero pending, zero failures, matching worker digest/counters, and a fresh
  verification performed within the last 30 seconds.
- A cached proof expires after 30 seconds; do not keep a green verified
  status forever when files may be mutable. A changed sample, process
  transition, Agent reconnect or verification race invalidates proof.
- `failed`, `lost` and ambiguous restarts stay distinct. The watchdog
  never triggers a process retry; retry policy continues to require
  explicit authorization, reconciliation and bounded idempotent budget.

A worker saying GPU saturation is **worker-reported**; no independent GPU
occupancy sensor was added. High claimed GPU usage plus no completed files
remains stalled/suspected, never falsely `completed_verified`. A reconnect
does not imply a task was executed twice, and it does not justify replay.

Operator-only optional offline check:

```text
npm run progress:verify -- --trusted-request ABSOLUTE_PATH_TO_OWNER_PROVISIONED_DESCRIPTOR.json
```

It verifies only result files; its JSON explicitly says
`completedVerified:false` and
`processExitIndependentlyAttested:false`, because a standalone file scan
cannot attest to Agent process exit. A request descriptor written by the
worker itself is NOT an independent trust anchor.

### Acceptance evidence and remaining blockers

Test fixture `test/fixtures/progress-result-worker-fixture.cjs` uses only
temporary directories and controlled Node processes. Negative cases:
fabricated completed/pending, tampered result bytes, wrong account/device/
project/run/session, missing/duplicate results, result identity drift,
hardlink aliasing, timestamp inconsistency, verifier/sample race, GPU report
without output, queue growth, crash or ambiguous exit and reconnect.
A Windows symlink fixture is attempted but may be skipped when the OS denies
creating a symlink; hardlink rejection remains tested.

**NOT PRODUCTION ACCEPTANCE:** Neither worker-created JSON nor worker-owned
manifest is a cryptographically attested independent record of semantic
correctness. Production still needs Agent-owned immutable write-once results
or a protected artifact handoff/manifest signer, trusted scheduling of total
work, filesystem ACL boundary and handle-safe TOCTOU protection, persistent
proof journal after Agent restart, external process exit ownership check,
physical 2-device acceptance and long-running real workloads. This module
is not automatically invoked for arbitrary process.read responses because
no trusted per-session project/total/root binding has been provisioned.
Unconfigured processes remain self-reported/unverified; no fabricated green
status. The actual crypto model/trading bot was not started.


### Post-merge #559 / #550 Windows acceptance note (2026-10-18)

PR #550 merged into main as ca7fc2c while the verifier follow-up was in
progress. This implementation therefore targets a separate DRAFT follow-up
PR against main instead of rewriting a merged PR.

The unrelated Win32 Job Object change from PR #559 makes Native Process
Manager refuse process.start without its pinned native Job owner EXE.
The isolated Work PC source worktree lacks native/windows-job-owner.exe.
The existing process.start/read integration test is now conditionally
SKIPPED **only** when that helper is absent, with explicit evidence.
No native Process Manager code or runtime trust checks were weakened.
The new independent result-file verifier tests execute controlled temporary
Node worker subprocesses without invoking Native Process Manager; they do
not substitute for a true Windows Job Object acceptance test.
Linux CI can still run the original process.start/read integration test.

Reviewers must distinguish targeted PASS, physical Win32 process-start
SKIP, GitHub exact-head CI and production release gates.
