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
