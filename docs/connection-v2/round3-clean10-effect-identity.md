# CLEAN-10 Round 3 | Durable semantic-effect identity and release contract

**Integration only:** #1085 Draft. **Release decision: NO-GO until independently accepted.**

## Threat and source evidence

Historical #1075 mandatory test `test/clean-10/runbook-unknown-acceptance-red.test.ts` remains byte-identical (Git blob `720565cf8821f9ceea9e5ca6101c0213558a1c09`). It demonstrates two pre-fix failures: native `MUTATION_STATE_UNKNOWN` was downgraded to retryable `FAILED` and a cloned caller-controlled runbook ID dispatched the same uncertain effect.

The source-only QA-18 unsafe proof had expected the vulnerable behavior and consequently becomes invalid as a *passing* post-fix regression. Round 3 changes only that legacy test's expectation to require UNKNOWN and no redispatch. Its original source Git blob remains reachable as source #1075.

## Admission and persistence boundary

- Every task-graph step computes a canonical SHA256 fingerprint of its effective graph plus execution target. Caller-provided `runbook_id`, step name, graph_id and retry/timeout aliases are not fresh mutation authority.
- A deterministic `rb-` graph ID is derived from the semantic fingerprint; an independently accepted fresh intent ID gives a different graph ID.
- `RunbookStore.reserveSemanticEffect()` writes an owner/device-bound reservation to `<runbooks-stateFile>.semantic-effects/effect-<sha256>.json` using exclusive file creation (`O_EXCL`, mode 0600), flushes file content and (on POSIX) the directory entry **before any task-graph callback**.
- The reservation is permanent even for SUCCESS; there is no time-based expiration, pruning, rollback or auto-replay. Interrupted/corrupted/inaccessible journal state causes fail-closed denial. Old native runbooks without an indexed reservation require independent migration reconciliation.
- The state file and reservation root must be under the intended trusted user/agent state directory; POSIX directory ownership/mode and private regular-file metadata are audited. Full Windows SID/DACL acceptance of this new journal has **not** been independently tested and remains a release gate.
- All runbook outcomes tagged `MUTATION_STATE_UNKNOWN` or `RUNBOOK_EFFECT_*` are retained as durable `unknown`, not retried as `failed`; a caller's `retry_unknown=true` flag is never independent authority to dispatch the same previously reserved effect.
- This is a canonical *syntactic graph* fingerprint, not a proof of equivalence for arbitrary rewritten commands, reordered independent operations or semantically synonymous payloads. A strong production owner-issued effect intent identifier and authenticated evidence are still needed for adversarial reformulations. Do not mark universal semantic dedup proven.

## Explicit fresh user-intent authorization

To allow a genuinely new identical effect, task_graph steps may supply `semantic_intent={id,owner_id,device_id,authorization_receipt}`, but **input alone is never accepted as a grant**. Existing reservations can only be superseded by `RunbookExecutionCallbacks.authorizeFreshEffect()`, a trusted server-side callback which must independently verify:
1. The credential was issued by the verified owner for the current device and current policy/epoch.
2. `intent.id` is globally unique for that owner/device, not a rotated runbook/request ID.
3. The signed receipt binds SHA256 fingerprint, owner/device, specific intent ID and expiry or explicit owner approval and is not revoked.
4. The provider has a trusted one-time replay ledger or equivalent CAS before approving a new physical effect.

A verified intent creates a separate, non-expiring `intent-<sha256>.json` reservation. A duplicated ID fails, even if the outer runbook ID changes. **The live Agent executor has not wired an independently authenticated receipt provider**, so repeated identical effects remain fail-closed; users cannot self-authorize a replay by setting JSON fields. This is safe but is not complete production UX acceptance.

## Required negative matrix

| Case | Required behavior |
|---|---|
| Dropped ACK / timeout | Durable UNKNOWN; no automatic rerun |
| Cloned runbook / renamed step | Existing reservation denies callback |
| 32 concurrent reservations | Exactly one successful O_EXCL admission |
| Agent restart | The same semantic key remains blocked |
| Journal corrupt / unavailable | No callback or fallback execution |
| Foreign owner/device | Owner/device mismatch rejected |
| New intent without trusted verifier | Denied |
| Verified new user intent | Separate one-time reservation; reused ID denied |
| Previously unindexed historical mutations | Fail closed pending owner reconciliation |
| Windows QA-02 missing native helper | Build genuine Job guardian in disposable CI, preserve output-ordering assertion |

## Separate QA-02 cause and fix

Job `126661202418` failed before it could perform the physical pipe-ordering assertion: `WINDOWS_JOB_HELPER_UNAVAILABLE` from `src/agent/windows-job-owner.ts`. The Round 3 coordinator-only workflow compiles `./scripts/build-windows-job-owner.ps1` before QA-02. It neither mocks an owner nor changes the negative assertion.

## Release acceptance

CLEAN-10 mandatory source test, new concurrent/restart/corruption/owner tests, existing runbook tests, QA-18 updated regression, Linux and Windows Node22/24 must pass at **one exact integration SHA**. Native Git DAG and all source blob SHA rows must pass without relabeling altered code as `EXACT_BLOB`. Windows Cloudflared P1-B/D, new journal Windows ACL and genuine external staging remain independent NO-GO blockers. No main merge, source branch push, paid provider, credential change, or physical PC mutation is authorized.
