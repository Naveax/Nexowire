# Nexowire #09 | Self-host worker, escrow and platform capability contract

**2026-10-24 · design / staging contract ONLY · no runtime wiring · production NO-GO**

## Immutable source and acceptance boundary

- `main` at audit start: `754cc4364822be5fda528f54042fb22a84f19924`.
- #718 quota owner HEAD: `d0a9ba925580c44c5f2f48a709fb0b7e968430c1`; six CI jobs passed, Windows browser-live failed fast-exit pipe-drain assertion, not this quota source. This document and the narrow COMPLETE cleanup guard are stacked on that exact source, not merged to main.
- #835 hostile logical clone HEAD: `e0c34b7bf7106a99a4de1abc1019ffa98e4268d1` (local WAL oracle, no cross-host authority).
- #774 UNKNOWN escrow QA HEAD: `5e432c26072d82e89069fc702e634a80d2d02534` (source CI SUCCESS; synthetic memory escrow).
- #768 external publication commit source HEAD: `00ad9a4f061a4da2a0215e470b302f1e25950e4e` (source CI SUCCESS). **Signed publisher final receipt != exclusive writer-stop != physical deletion.**
- #738 4x9.5 MiB gzip/quiet-ingress stress HEAD: `ce85d257c2f005156175a4d14a65ec81565575fc` (7/7 source CI SUCCESS). Not 101+ real WSS clients or a 1 GiB physical file.
- The effective hosted Free policy remains **1,000 weighted units / UTC month**. Daily Free/Plus/Pro 1,000/5,000/10,000, enterprise/custom entitlements and subscription activation remain unaccepted proposals. Billing stays paused.

## Current implementation inventory and safety boundary

| Concern | Observed source boundary | Actual claim |
| --- | --- | --- |
| Artifact bytes and concurrent capacity | `src/ops/scale-v2-artifact-byte-budget-staging.ts`: WAL `BEGIN IMMEDIATE`, PENDING chunk, storage reservation, rolling-minute byte budget, one-time RELEASED | Isolated **local** ledger only |
| Canonical mutation | `beginForLogicalMutation(..., authority)` and retained `budget_artifact_logical_reservations` | Requires injected external exclusive authority; no deployed cross-Hub CAS |
| Physical cleanup | `src/ops/scale-v2-artifact-fenced-cleanup-admission.ts` requires current CORE, writer revoke, stop-through, reconciliation, independent deletion/readback and distinct publication issuer/commit | Interfaces/witnesses, not a provisioned signer or exclusive disk provider |
| Publication | #768 `commitPublished` is distinct from native final hash/ACK | An external commit does not prove writer stop or deletion |
| Hosted entitlement | `src/product/*control-plane*`, D1/local implementation; scale-v2 proposals | Existing monthly Free only; no daily/paid cutover |
| Native transport | `docs/PROVIDERS.md`: outbound first-party Agent WebSocket; mutation disconnect -> UNKNOWN | Transport health never grants OS authority |
| Worker lifecycle | `docs/AGENT_LIFECYCLE.md`: Win per-user Scheduled Task, Linux systemd user, macOS LaunchAgent | Running lifecycle != usable capability or secure task sandbox |

**Ledger rule:** Logical invocation, reservation escrow, staged bytes, wall-clock CPU/disk cost, transport ingress and monetary prepaid settlement must be **separate counters**. Neither publisher success nor a locally closed session refunds bytes already admitted to a rolling window.

## Proposed trusted worker contract (not implemented)

A self-hosted durable worker is an *additional independently enrolled principal*, never an alias of a currently logged-in user's Native device.

```ts
type CapabilityTruth = 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';
interface DurableWorkerBinding {
  tenantId: string; accountId: string; ownerId: string;
  workerId: string; workerEnrollmentGeneration: number;
  targetDeviceId: string; targetDeviceEpoch: number;
  originalRequestId: string; logicalMutationId: string;
  ownerEpoch: number; grantGeneration: number; worktreeSha256: string;
  expiresAtUtcMs: number;
}
interface StepEscrowLimit {
  maxSteps: number; maxWallMs: number; maxCpuMs: number;
  maxMemoryBytes: number; maxWorkspaceDiskBytes: number;
  maxIngressBytes: number; maxEgressBytes: number;
  maxTokenUnits: number; maxNativeDispatches: number;
  maxChildProcesses: number; maxConcurrentSteps: number;
}
interface ExternalWorkerAuthority {
  // Must be authoritative across Hub/Worker instances, not SQLite on the
  // user-controlled workstation. Lease and both counters are atomic.
  withCurrentExclusiveStep<T>(
    binding: Readonly<DurableWorkerBinding>,
    stepIndex: number,
    limits: Readonly<StepEscrowLimit>,
    apply: (proof: Readonly<{
      reservationId: string; ownerEpoch: number; workerId: string;
      ledgerRevision: number; state: 'NEVER_DISPATCHED';
    }>) => Promise<T>,
  ): Promise<T>;
}
```

The example is an **integration target**, not an exported API or an implementation promise. A production authority must atomically protect the immutable canonical logical mutation key and monotonic owner/grant/worker epochs. The same CAS lease must cover local reservation and pre-dispatch transition. Device/user JSON, locally writable SQLite, session cookie and stale WSS pairing never authorize work or paid entitlement.

Worker identity key scope: `(tenantId, workerId, workerEnrollmentGeneration)` is unique and revocable; `targetDeviceId` is a separate *authorization target*. Enrolling a second worker cannot mint a new tenant quota subject. Worker cert/secret must use OS-protected storage; log only key IDs/digests, never bearer material. Headless worker never silently inherits interactive GUI permissions or Windows Broker HIGH.

## Durable dispatch and resource budget order

1. **Read independent owner/grant/target-device truth** and signed, explicitly configured plan from the authoritative service. Missing issuer or stale worker enrollment -> `UNAVAILABLE`, deny.
2. **Get physical capability truth** for each requested resource. If the OS provider cannot *enforce* memory/CPU/disk/child/network limits, return `UNAVAILABLE`; telemetry and process-tree observation do not count as a sandbox.
3. **Acquire external canonical logical-mutation CAS + per-step and tenant escrow before native dispatch.** Dedupe on immutable `originalRequestId` + `logicalMutationId` + `ownerEpoch`, not runbook/task name or new session ID. Reserve disk bytes at declared upper bound; enforce integer overflow-safe ceiling. Enforce max time/step/token limits before every next step, not just at task start.
4. Persist durable checkpoint `RESERVED -> DISPATCH_INTENT -> (ACK_VERIFIED | MUTATION_STATE_UNKNOWN)` with monotonic revision. Native effect may have happened before ACK; no blind resend on timeout, reconnect, cancellation or re-pair. Current owner revocation **stops new dispatch** but retains UNKNOWN cost and escrow.
5. On legitimate completion, independently confirm the operation result and bounded output; publisher final signed receipt and rollback-independent publication CAS cover **publication** only.
6. **Release disk escrow once** only after issuer-separated writer-stop/revoke, all generations fenced, durable reconciliation, exclusive external readback and physical deletion of staged content, using the same current authority lease. `COMPLETE` is not a synonym for `NO_LIVE_WRITER`. Rolling ingress/minute traffic and actual consumed quota are never refunded simply because files were deleted.
7. If any authority times out, moves backward or disagrees, persist `RECONCILE_REQUIRED` and deny new mutating dispatch; a human-approved reconciliation must cite the existing original request/epoch and physical proof. No side-effect rollback promises without demonstrated provider support.

Escrow semantics: `PENDING` and `MUTATION_STATE_UNKNOWN` **hold** memory/disk reservations conservatively; cancel/owner revoke/expired lease cannot free them automatically. For permanent worker loss, an independent trusted writer-stop, deletion and owner-grant readback is required. Quota admission is *not* OS or billing authorization; prepaid billing needs separately verified provider settlement.

## Platform truth matrix: discovery does not imply enforcement

| Runtime | Known lifecycle | Task isolation / network restriction / child containment | GUI and privilege rule |
| --- | --- | --- | --- |
| Windows user Agent | Scheduled Task in interactive user session, single-instance lease | Job-based process control exists in source; **real task sandbox, protected token, per-task filesystem and network boundary UNAVAILABLE until physical acceptance** | UAC Secure Desktop and HIGH Broker never delegated by quota or WSS |
| Linux user Agent / headless worker | systemd user service, linger only by explicit operator choice | Namespaces/cgroups/seccomp, mount/network namespace, protected task root require separate actual provider proof; otherwise **UNAVAILABLE** | No implicit X11/Wayland display/portal permission; fail unavailable |
| macOS user Agent | per-user LaunchAgent after login | Resource limits, sandbox-exec/Seatbelt and filesystem/network enforcement not proven for tasks; **UNAVAILABLE** | TCC/Accessibility/Screen Recording grants independent, not inferred from process presence |
| WSL2 target | Explicit routed target on Windows | Separate Linux guest identity/root policy and boundary required; no inheritance of Windows Host HIGH | Host GUI/UAC inaccessible without separate grant |

Never label `UNKNOWN` as `AVAILABLE`, infer remote capability from a hardcoded OS name, or upgrade readonly status checks to authority. Advertise specific unavailable capabilities to the caller, with bounded structured denial instead of silently substituting an unconfined executor. A provider must publish its exact OS build, isolation mechanism, resource limit enforcement evidence and revocation epoch.

## Acceptance and handoff

**Source/staging negatives to preserve:** #718 completion/cancellation hold, owner re-pair, cloned original task, revoked generation, forged publisher, external readback failure, release-once, rolling traffic retained; #774 lost final ACK and signed-looking publication with no stop/deletion; #835 duplicated two-Hub logical mutations. The new #09 negative specifically closes the COMPLETE direct-ledger writer-fence bypass in staging.

**Required independent acceptance (NOT achieved here):** two separate Hub/Worker machines share one anti-rollback CAS and real signed issuer; kill one worker after intent and before ACK; prove no second dispatch or refund; cross-owner revoke/re-pair and stale writer generation cannot reclaim disk; disk readback and deletion under held lock; resource pressure per OS with measured child/network containment; 101+ authenticated simultaneous WSS, full 1 GiB end-to-end digest and no noisy-tenant starvation. Public/load/paid cloud tests require separate approval and isolated budget.

**Owner boundaries:** #01 canonical mutation journal/external effect CAS, #03 Artifact physical stop/deletion and signed publication, #04 owner enrollment and WSS issuer, #05 loop execution semantics, #07 physical OS sandbox, #09 shared resource/tenant escrow + quota ledger and capability report, #12 production wireup. This document does not modify any other owner's runtime.

**State now:** `SOURCE/STAGING` for local tests; `BLOCKED` for off-host exclusive CAS, signed writer-stop/deletion, production daily/paid entitlement, physical OS sandbox and multi-device/WSS scale. No work on production D1, billing, live Agent, UAC, paid cloud or ReVoltVPN-Ubuntu-Lab.
