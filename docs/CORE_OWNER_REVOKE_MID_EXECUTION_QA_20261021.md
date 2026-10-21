# P0 #25: Owner revoke mid-execution, source-only adversarial QA

**DRAFT. NO PRODUCTION DISPATCH.** This branch changes only a source test and this document. No live Agent, elevated shell, Broker, UAC, VM, service or device is touched.

## Exact inspected refs, 2026-10-21

| Ref | HEAD | Notes |
| --- | --- | --- |
| main | 754cc4364822be5fda528f54042fb22a84f19924 | Not branch base |
| #574 | 2adf0e29fd41914a842cafd7fdadef25d24da103 | ROOT lifecycle, prior Actions failure |
| #621 | f5545741902c15d7b51e98b73d0f4e5ec63daf23 | CORE owner delegation; child of #574 |
| #631 | 4e0cb8f5a00deb7ca00352ff24350402936ba59c | Witness delegation; child of #614 |
| #633 | c429ed9c7eb6de45c4c1ae8de67b528f940fe3ab | Broker admission source; **this QA branch base** |

The inspected #633, #621 and #631 workflow runs reported SUCCESS, not installed Windows acceptance. All four are DRAFT; revalidate exact refs and CI before integration.

## Deterministic negative coverage

Test: test/core-owner-revoke-mid-execution.adversarial.test.ts

| Adversarial condition | Source gate observation | Production requirement |
| --- | --- | --- |
| Owner revoked after queueing | GRANT_REVOKED | Revoke fence wins before dispatch; zero effects |
| Owner revoked during synthetic gated read | Recheck rejects; synthetic effect array stays empty | No further irreversible chunk after revoke |
| Owner re-paired, credential/epoch rotated | WRONG_DEVICE_OR_OWNER_EPOCH | Old signed enrollment and queued work fenced |
| ROOT T+899999ms / T+900000ms | Candidate before boundary, ROOT_15_MINUTES_EXCEEDED at boundary | Native clock trust; never extend grant |
| Mutation sent, ACK lost | UNKNOWN_MUTATION_NO_REPLAY | Externally reconcile; never automatically replay |
| Already reserved request ID | STALE_OR_REPLAYED_REQUEST | One durable idempotency key, no second dispatch |
| CAS unavailable or forged owner witness | Fail closed | No local-cache permission fallback |
| Preapproved CORE broad verbs | shell/process types remain accepted as *source-only candidates* | Real signed high-token Broker required; no per-command UAC |

The test calls the actual PR #633 evaluateCoreBrokerExecution source function. It re-enters the function at deterministic synthetic handoff points. It does **not** prove the native Broker checks authority mid-execution. The parent explicitly has CORE_EXECUTOR_DISPATCH_ENABLED=false.

## Critical unresolved race

Current source gate checks ownerRevoked **before** pendingMutationUnknown. With both true, it reports GRANT_REVOKED even if an external effect may have been dispatched. This cannot be interpreted as CANCELLED or no-effect proof. No automatic retry is permitted, but a durable runtime must keep possible side effects UNKNOWN until independent reconciliation.

Required native/external ordering: durable reserve -> fresh trusted owner/grant epoch fence -> native dispatch -> authoritative acknowledgement/readback. For revocation before the irreversible boundary, prove no remote send and permit CANCELLED. For revocation/cancel after a possible send or lost ACK, keep MUTATION_STATE_UNKNOWN and do not replay. A local process exit, forged cancellation receipt or HTTP success is not proof of remote effect.

A real off-process monotonic CAS must atomically bind device, owner, credential, grant generation, requestId and session epoch. Recheck before each side-effecting operation/chunk. Already-running uninterruptible native calls may complete despite revocation; they require independent readback and must not be reported as successfully cancelled.

## Ownership and integration

- #03 Broker owner: native fence, side-effect journals, loss-of-ACK receipt semantics, high token, Authenticode publisher, protected parent/import ACL.
- #04 Access owner (#621/#574): owner revoke, re-pair, session-bound ROOT max 15m and durable CORE invalidation.
- #01 Witness owner (#631): real external monotonic CAS; a Map/Postgres simulator is not production trust.
- #00 integrator: reconcile separate owner stacks and prove exact-SHA CI and physical Windows attestation before any P0 merge.

## Reproduce

Node.js 22 in a clean checkout of this QA branch:

~~~bash
npm ci
node --test --import tsx test/core-owner-revoke-mid-execution.adversarial.test.ts
npm run typecheck
~~~

All fixtures are source-only and no privileged command is executed. Real physical acceptance, installed Windows elevated Broker, external CAS and true mid-flight revocation **BLOCKED**.