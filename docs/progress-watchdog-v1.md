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
The controlled process.start/read integration tests are conditionally
SKIPPED **only** when that helper is absent, with explicit evidence.
When provisioned, the new bounded temporary fixture uses the real native
Process Manager/Job guardian, receives the Agent-assigned session ID over
stdin, emits result hashes/counters on stdout, and checks observed process
exit plus on-disk proof. A genuine completed task reaches
`completed_verified`; an inflated counter with a sealed but incomplete
manifest reaches `progress_mismatch`.
No native Process Manager code or runtime trust checks were weakened.
The new independent result-file verifier tests execute controlled temporary
Node worker subprocesses without invoking Native Process Manager; they do
not substitute for a true Windows Job Object acceptance test.
Linux CI can still run the original process.start/read integration test.

Reviewers must distinguish targeted PASS, physical Win32 process-start
SKIP, GitHub exact-head CI and production release gates.

### Follow-up #575: Windows Job pipe drain and bounded file reads (2026-10-19)

- Initial GitHub CI run `39155483038` failed solely in Windows
  `browser-live` > `Physical Windows Job Object regressions`:
  `Windows Job preserves separate stdin/stdout/stderr pipes` observed
  `status=exited` before `WINJOB_STDOUT` was read. The source-built
  local native helper reproduced correct output 24/24 times; the
  intermittent ordering hypothesis is **not** claimed proven solely
  by the earlier CI failure.
- The existing physical Windows Job test retains strict, separate
  stdout/stderr content assertions and the Job-owned exit requirement,
  but polls with a bounded 50 ms delay after early terminal observations
  instead of spinning through the entire read budget before asynchronous
  pipe callbacks can deliver their last events. Missing output still fails.
- The result verifier reads at most each file's previously attested size
  (128 KiB per result, 256 KiB for manifest) from the open handle.
  A worker appending while scanned can no longer trigger an unbounded
  `FileHandle.readFile()` allocation; stat/identity/mtime changes fail closed.
- New negative tests cover matching file hashes with nonzero or
  **unknown** OS exit, and a too-large file with a forged matching
  manifest SHA-256. Neither can reach `completed_verified`.
- A separately controlled Windows native Process Manager fixture now
  tests complete versus forged-progress output end to end. Its command
  parameters use guarded metacharacter-free test paths on Windows to
  avoid pre-existing cmd.exe quoting ambiguity through the native helper.
  Paths requiring different native quoting are **BLOCKED**, not silently
  allowed. The production helper executable trust chain remains a separate
  requirement.


### #575 strict completion correlation and #588 observer adapter (2026-10-20)

- `completed_verified` now requires all previously independent JSON file
  SHA-256/count/scope checks **plus** an externally bound UUID `requestId`,
  exact captured stdout progress-line SHA-256, observed OS exit 0,
  Agent-observed exit timestamp, bounded timestamp ordering, and an
  out-of-band trusted storage attestation of the result set SHA-256.
  File-consistency `progressVerified:true` **alone** no longer means
  `completed_verified`: without trusted attestation a clean exit remains
  `reported_complete` and `verificationReasonForCompletion` is
  `IMMUTABLE_ATTESTATION_REQUIRED`.
- `TrustedCompletionAttestation` is a **boundary contract**, not a
  cryptographic token or implementation of immutable storage. A normal
  worker cannot supply it from stdout or from its own manifest. Until an
  independently authenticated Agent-owned immutable storage provider is
  connected, real production work must not receive this attestation.
  The isolated unit tests explicitly simulate the provider for acceptance
  policy testing; their success does NOT establish storage immutability.
- Additional negative acceptance: forged requestId, immutable digest,
  stdout hash, commit/exit timestamps, unknown/nonzero exit, lost child,
  malformed telemetry after proof, 0 new results, pending-zero process
  stalled without actual exit, and stale stdout replay from an older
  Hub reconnect epoch. Invalid telemetry now invalidates cached proof.
  `mutation_unknown` remains non-retryable without outside reconciliation.
- New stand-alone `artifact-transfer-progress-adapter.ts` for issue #588
  consumes **actual** ArtifactBridge `begin`, `putChunk`, and `commit`
  receipts. Reports 65,536-byte chunk counters, last acknowledged chunk
  SHA-256, confirmed offsets, previously persisted resume offset,
  remaining bytes, full-file SHA-256, and only confirmed-complete storage
  results. Duplicate acknowledged chunks do not increase counts.
  `mutation_unknown` strictly blocks automatic replay; an operator must
  reconcile through the owning Artifact Bridge API. The adapter does
  not touch `src/workspace/artifact-bridge.ts`, the ingest/store
  implementation, native Process Manager, or live Agent.
- Adapter test invokes a real isolated `ArtifactBridgeStore` with
  2x64KiB+123-byte payload, reconstructs the adapter from its durable
  resume offset, re-reads the committed manifest, and verifies negative
  lost-response/offset/sha/oversized-chunk scenarios.
- **Not production accepted**: missing actual immutable storage attestation,
  signed/ACL-controlled authoritativeness for requestId/exitedAt,
  output-proof durable WAL after Agent crash, protected cross-owner handles,
  physical 2-device acceptance and representative long-running workloads.
  No live crypto bot or GPU benchmark launched.


### Historical #575 transfer receipt prototype (2026-10-20; superseded 2026-10-21)

`src/agent/one-call-transfer-watchdog.ts` is a standalone, read-only
observer of the current **#596** `artifact_bridge_ingest_device_file`
response and the proposed **#597** single-call `transfer_status` /
`transfer_cancel` status/cancel responses. It never changes
`src/workspace/artifact-bridge.ts`, `src/mcp/artifact-bridge-*`
(#08 owned), or ProcessManager (#03 owned), and does not initiate transfers.

**Provenance levels are distinct:**

1. `PARTIAL`, `COMPLETE`, `ALREADY_PRESENT` responses contain
   `state`, `sha256`, `size`, `offset`, `transferredBytes`, and
   `artifactPath`. Their byte offsets and derived 65,536-byte chunk
   counts are **receipt claims**, not independently attested immutable
   content. These receipts provide NO per-chunk hash list or
   requestId binding on their own; the authenticated invoker must
   pin scope/UUID and validate source authenticity. The observer refuses
   regressions, overflows, invalid hashes and offsets, and inconsistent
   reported transfer bytes.
2. Only after an externally authenticated `ArtifactBridgeStore.get`
   and independently content-hashed `readChunk` response match the
   pinned account/project/device/artifact/SHA-256/size does the adapter
   expose `storageVerified=true` and a
   `lastVerifiedChunkSha256`. It expires after **30 seconds**.
   It uses bounded 64 KiB reads, not one giant MCP payload. The
   filesystem/storage verification does NOT prove a worker completed a
   valid task.
3. `workerCompletedVerified=false` is deliberately invariant.
   Worker-reported completed counters, PID liveness, or even a valid
   stored artifact must NEVER be promoted into
   `ProgressSupervisor.completed_verified` without its separate
   trusted request/output/exit/immutable-attestation contract.
4. A lost mutation response sets `mutation_unknown`; no automatic
   replay, cancel or retry is performed. The proposed status receipt
   can explicitly reconcile a reported offset/cancel state but does
   NOT prove on-disk content. Cancel is a terminal noncompletion.
   Zero persisted-byte growth under a running/lying worker generates
   `NO_STORAGE_PROGRESS`; lost child PID generates
   `WORKER_PID_LOST`. A 1 GiB+ transfer can be represented by
   bounded integer metrics without allocating its contents in RAM.

**Integration blocker:** At inspection, PR #596 (HEAD
`22675eeb46b7360622a0800ac5d293fee63b2e68`) remains DRAFT.
It still provides at most 32 chunks per MCP ingest call and may return
`PARTIAL`. The #597 child QA demanding one-call background transfer
plus authenticated `status/cancel` is also OPEN/DRAFT and intentionally
red against that contract. The proposed status/cancel receipt observer
is therefore a *contract adapter*, not a claim that those endpoints
exist or that background copy execution has been accepted.
The existing store-backed tests exercise the actual begin/putChunk/
commit/get/readChunk APIs and use synthetic receipt DTOs only for
interfaces that #596/#597 have not implemented.

Production remains **NO-GO** pending authenticated single-call transfer
execution, durable owner-bound status/cancel receipts, trusted immutable
artifact handoff, full provenance and end-to-end two-device acceptance.
No live crypto/GPU workload, production deploy, automatic replay, or
unsigned Job helper installation was attempted.


### 2026-10-21: exact #596 head 33504656 after #597 QA merge

**Current one-call ABI (source-only, #596 remains DRAFT):**
`artifact_bridge_transfer_start` accepts source/target device/path, optional
project/expected hash and explicit `resume_transfer_id`; it returns a
`CrossDeviceTransferJobs.public()` receipt immediately. Authenticated
`artifact_bridge_transfer_status` and `artifact_bridge_transfer_cancel`
now exist. Their output fields are: `id` (UUID), `state` (`QUEUED`,
`RUNNING`, `RECOVERY_REQUIRED`, `FAILED`, `MUTATION_UNKNOWN`,
`CANCEL_REQUESTED`, `CANCELLED`, `PUBLISHING`, `COMPLETED`),
`bytesTotal`, `bytesConfirmed`, `sha256`, source/target device/path,
`updatedAt`, optional `errorCode`. The earlier PARTIAL/COMPLETE DTO
belongs to the older bounded-ingest API; the previous section documents
that historical prototype, NOT the current one-call adapter.

**Reworked independent `src/agent/one-call-transfer-watchdog.ts`:**
- Pins externally authenticated caller `requestId`, source/target device,
  path and optionally source SHA-256, then binds the returned transfer UUID.
  Validates monotonic time/offset, safe integer size, chunk boundaries and
  identical transfer identity/hash on every start/status/cancel receipt.
  No full binary body is included in RPC responses.
- `COMPLETED` with all bytes acknowledged is only
  `publicationReported=true`. Even `PUBLISHING` with all bytes cannot
  become storage proof. To obtain `readbackVerified=true`, the caller
  supplies a separate **authenticated target-side** `stat`, complete
  `hash`, last <=64KiB `read` and a second complete `hash/stat` through
  Native read-only APIs. All hashes and byte counts must agree. Proof
  expires after 30 seconds. Native v1.0.5 >256MiB hash/offset acceptance
  remains BLOCKED.
- `atomicNoOverwriteVerified=false` stays explicit. Final readback
  can establish *observed destination content consistency*, not historic
  no-overwrite/atomic-move provenance or immutable custody.
  `workerCompletedVerified=false` is invariant; transfer status is
  **never** an immutable worker result or `completed_verified`.
- `MUTATION_UNKNOWN` and `RECOVERY_REQUIRED` prevent implicit replay;
  a renewed receipt is accepted only by an explicitly owner-approved
  resume call after the #596 job manager reconciles source and staging.
  `CANCEL_REQUESTED`/`CANCELLED` are not completion. Persisted zero
  byte growth or lost child status raises warnings, even if worker
  counters claim 100%. `FAILED`, `PUBLISHING` rollback, canceled
  publication and changed owner/target/hash are rejected.
- **Permanent #575 suite:** 11 exact-DTO adapter tests including fake
  completion, independent correct/mismatching target, mutation between
  first and final hash, stale proof, stalled fake progress, lost PID,
  UNKNOWN/resume, cancel, rollback/forgery and 1GiB+ accounting without
  allocating the payload. The existing Progress/Proof fixtures remain.
- **Independent cross-branch local acceptance:** using an **ephemeral
  uncommitted source copy** from real #596 HEAD
  `335046569a38f3a1a3fc82bf851f9b7df7640fdb`,
  4/4 tests exercised actual `CrossDeviceTransferJobs`: 221KiB+
  single logical start, observed `COMPLETED` followed by target-side
  SHA/readback; lost-write-ACK `MUTATION_UNKNOWN` followed by explicit
  reconciled resume without duplicate write; cancel prevented
  publication; pre-existing destination was never overwritten. All
  isolated fixture copies were removed before PR commit. The source
  owned by #08 and all live Agents remained unchanged.

**Acceptance limitation:** This DRAFT #575 verifies observed transfer
integrity only. A privileged, authenticated, immutable Agent-owned
artifact/result handoff with durable `requestId`, output SHA-256,
exitCode/timestamps and signed/independent acceptance remains absent.
No status RPC, readback alone, or synthetic fixture may assert
production `completed_verified`. The #596 source still awaits its own
integration, signed release and two-device real acceptance; no live
crypto bot/GPU workloads were launched.


### 2026-10-21 / #11 P0: independently sealed CORE result completion (staged only)

- PR #575 source-only strict verifier `src/agent/trusted-worker-completion.ts`
  now requires an **Ed25519 signed, canonical, domain-separated result
  statement**, independently pinned **second** Ed25519 key for the
  off-host immutable-storage seal (same key is explicitly rejected),
  and content-addressed complete off-host SHA-256 readback via <=64KiB
  chunks. The object bytes describe the bound statement *excluding its
  own digest*, avoiding circular hashing. Readback is limited to 128KiB
  proof metadata; worker bulk results still use separate Artifact Bridge.
- The signed statement binds owner account, project, device, run/session,
  trusted invocation request UUID, CORE grant ID and positive **owner
  grant epoch**, source/target devices and path (distinct physical/logical
  identities), transfer UUID, result-set digest, remote object digest,
  exact worker output SHA-256, completed/pending/failed (pending=0,
  failed=0), OS exit code 0, commit timestamp and OS-observed exit
  timestamp. Current authority is reread **before and after** off-host
  inspection. Grant must be `CORE/ACTIVE`, epoch exact, not revoked or
  cancel requested. Transfer must remain `COMPLETED` with exact target
  SHA, bytes and identity at both reads.
- Separately signed **immutable storage seal** binds owner, project,
  off-host destination, transfer UUID, owner grant epoch, object SHA-256
  and seal timestamp. Plain JSON `trusted_storage_adapter` objects
  and bare #596/#616 RPC receipts are **always untrusted**. Only
  `verifyOffhostCompletion` can mint a module-private, unforgeable
  `VerifiedCompletionPermit`, which `ProgressSupervisor` requires
  for the `completed_verified` state.
- `invalidateOwnerGrant(sessionId)` invalidates evidence and permanently
  blocks permit reuse for the same session upon CORE cancel/revoke/
  re-pair. UNKNOWN mutation effects never trigger automatic retry;
  signed transfer-state `MUTATION_UNKNOWN`, `CANCEL_REQUESTED`,
  `CANCELLED` and `RECOVERY_REQUIRED` cannot produce a permit.
  Verify-generation races, lost PID, reconnect and stalled worker
  remain covered by existing supervisor/transfer regression tests.
- **#616 current head** `94b92e01219aca3cd4ca86775fe4b61a72ac53c4`
  is CI-green staging for a *different* transfer-writer monotonic
  lease (epoch/token via `TrustedTransferAuthority`). This is NOT
  interchangeable with owner CORE grant epoch. Both will require
  separate genuine external authority and revocation/fence wiring
  before production. The #616 author explicitly reports external
  monotonic trust emulation as TEST-ONLY and physical NO-GO.
- **Staging limitations:** This verifier has no production-pinned
  authentic issuer public keys, owner CORE-grant authority, actual
  signed immutable off-host storage service, durable revoke event
  subscription, independently authenticated remote Agent readback,
  or tested crash-consistent two-device evidence. In particular, a
  signature from a mock off-host store is not proof that a real storage
  object is immutable. The caller MUST supply trusted ports; none are
  wired to the production Hub by this change. The in-memory revoked
  flag is not a crash-durable authority; after restart a current
  external grant lookup is still mandatory.
- **Tests:** Ed25519-positive permit and fail-closed negative cases
  for forged/missing signatures, reused same signer, forged off-host
  seal, partial/mismatched payload, wrong owner epoch, revoke/cancel
  before and during readback, stale signed receipt, UNKNOWN transfer
  state, transfer changing after readback, raw plain attestation,
  cached-permit replay after CORE cancellation, and proof corruption.
  No live crypto trading, GPU benchmark, 1GiB artifact file,
  production Agent/Hub restart or service mutation is involved.
- Only #575 progress verifier/adapters/tests/documentation changed.
  #08 Artifact Store, #03 ProcessManager, physical Agent and broker
  remain untouched. **Production completion acceptance is NO-GO**
  pending genuine second-party sealed custody and independent QA.


### 2026-10-21 #11 follow-up: independent runtime SHA-256 postcondition (staging only)

PR #575 introduces `src/agent/progress-runtime-postcondition.ts` as a
**read-only, source-only** handoff adapter. The runtime never starts a
transfer, writes Artifact Bridge files, controls a Job owner, or replays a
remote mutation. It requires **three distinct pre-pinned Ed25519
authorities**: the worker-result issuer, an immutable off-host storage
seal issuer, and a separate independent postcondition witness. None of
these keys may be worker stdout, user JSON, or the unauthenticated RPC
receipt. No production keys or provider are wired by this PR.

1. Bind owner/device/project/run/session, request UUID, CORE grant ID and
   exact owner grant epoch, job ID, source/target and expected result-set
   SHA-256. Read `readGrant` and `readTransfer` from **independently
   authenticated read-only transports**. CORE must be `ACTIVE` with
   exactly the current epoch. Transfer must be `COMPLETED`, full offset
   recorded, and target full SHA/length bound to signed proof.
2. `readPostcondition()` returns a separately signed Ed25519 result:
   requester UUID, job UUID, owner, project, target device/path, owner
   grant epoch, full-object SHA-256, confirmed bytes and timestamp.
   Signature and freshness (30s), digest, byte length and provenance
   are validated before trusting the response. A forged
   `COMPLETED` RPC is **never** sufficient.
3. Existing `verifyOffhostCompletion` independently re-hashes every
   64KiB chunk of the bounded 128KiB signed metadata object via remote
   `readOffhost`, checks a second differently signed immutable storage
   seal, and rereads CORE grant and transfer state after readback.
4. Before presenting the opaque permit to `ProgressSupervisor`,
   runtime rereads owner and transfer. After the supervisor rereads
   local result JSON, checks completed/pending/failed counts, exitCode=0,
   timestamps, output SHA and result-set digest, runtime repeats owner
   and transfer rechecks. CORE revoke/cancel/re-pair invalidates session
   proof; `CANCEL_REQUESTED` is not completion.
5. Lost ACK, missing/partial offhost bytes, forged digest/signature,
   transfer `MUTATION_UNKNOWN` / `RECOVERY_REQUIRED`, transport loss,
   stale grant epoch, failed release/cancel and corrupt result hashes
   fail closed. Ambiguous outcome becomes **sticky UNKNOWN** in this
   runtime adapter. `automaticReplayAllowed=false` always. Resuming
   requires a fresh, separately approved/reconciled session or operator
   workflow, never a silent worker retry.
6. Worker PID alive, fake 100%, stalled work and reported progress alone
   remain insufficient. The adapter cannot transform #616's test-only
   monotonic CAS or an unverified remote receipt into a real immutable
   custody service.

**Test evidence:** temporary result-worker fixture, in-memory synthetic
off-host provider, locally generated *test-only* Ed25519 keys; positive
runtime proof and adversarial old owner epoch, pending CORE cancellation
(including races across readback), forged postcondition or COMPLETED
receipt, lost ACK, tampered/truncated disk content, UNKNOWN job and lost
worker PID scenarios. These prove source contract behavior, **not**
production cryptographic key custody, durable revocation, independent
witness deployment or a physical off-host acceptance run.

**Production acceptance remains NO-GO.** Requires real authenticated
transport ports with independent key management, nonforgeable monotonic
CORE grant persistence / revoke delivery, real off-host immutable
artifact seal and separate postcondition witness, #616 genuine CAS/
writer fence and crash recovery, and two-device physical acceptance.
No #08 store source, #03 Job owner source, live Agent/UAC/VM, crypto
bot, or GPU workload was modified or started.
