# #617 Hyper-V / Admin Bridge: independent Error Contract QA evidence

Date: 21 October 2026. Owner: #02 Error Contract QA. Source branch based on [DRAFT #618](https://github.com/Naveax/Nexowire/pull/618), exact parent source `14d0d6f71ea2284c0f17a14e947f24d999aade37`.

## Observations, not permissions

Issue [#617](https://github.com/Naveax/Nexowire/issues/617) records a limited Naveax Agent v1.0.5 Windows token: Medium integrity `S-1-16-8192`, BUILTIN\\Administrators deny-only. Hyper-V services running and unauthenticated Broker HTTP `401` do **not** prove Hyper-V API rights, authenticated Broker health/version, trusted elevation, or owner approval. The user-supplied `Start-VM` denial and subsequent `Start-Process -Verb RunAs` / `consent.exe` observations do **not** prove current VM state or UAC grant. No real VM mutation, UAC interaction, Broker install, ACL or privileged token change performed here.

#618 adds `src/protocol/hyperv-elevation-evidence.ts`: a source-only, pure explanation projection with explicit `windows | nexowire | policy | user | undetermined` denialSource, `denied | pending | unknown`, `effectVerified:false`, `automaticallyRetryable:false`. It cannot execute Hyper-V or validate live VM state, and it does not itself emit a trusted requestId receipt.

## New QA additions, source-only, no #618 owner-file changes

- `test/qa-02-hyperv-denial-provenance.test.ts` verifies each **distinct** denial origin:
  - **windows**: Medium integrity / Administrators deny-only with no authenticated elevated Broker.
  - **nexowire**: offline Agent, unverified or version-mismatched Broker.
  - **policy**: missing owner grant or immutable VM GUID.
  - **user**: explicit local denial vs non-approval pending.
  - **undetermined**: lost RunAs/UAC confirmation, forged successful ACK, unknown VM side effect.
  - Negative proof: `consent.exe` existence, caller `approved:true`, stale `Running` record dated 2025, foreign host/wrong VMId `Running` record, full broker and approval facts **never** produce `succeeded` or `effectVerified:true`. Note: these extra VM state values are intentionally *outside the #618 source contract*; assertions prove the source-only explanation does not trust them, NOT that a production readback adapter exists.
- `test/qa-02-hyperv-unknown-audit.test.ts` tests two different real/synthetic boundaries:
  1. **Actual MCP → Hub → AgentProvider → mocked AgentBroker** request, with no command execution. Inject `MUTATION_STATE_UNKNOWN` and `AGENT_DISCONNECTED` after a simulated dispatch. The MCP normalizes both to `MUTATION_STATE_UNKNOWN`, preserves the **same UUID requestId** in provider call, error attribution and durable `started → unknown` audit, redacts synthetic Bearer token, enforces `reconcile_first`, and does not cause an automatic retry on MCP/Hub restart. `shell.exec` is **not** eligible for replay-safe idempotency, and we do not submit a second command.
  2. **Pure synthetic journal reservation** with a hypothetical `hyperv.vm.start` capability using the real `IdempotencyStore` and `AuditLog` APIs: post-dispatch `unknown` persists through journal restart, requestId audit correlation survives, same key returns `created:false`, and untrusted stale VM readback cannot turn the source-only explanation into verified success. **This is not a real Hyper-V service or operational capability**. The current `idempotencyEligibility('hyperv.vm.start')` correctly returns `false`.
- All existing #618 source and its eight tests remain unchanged. The #02 PR must not change `src/agent/process-manager.ts`, `src/agent/privileged-broker.ts`, `src/protocol/hyperv-elevation-evidence.ts`, Windows UAC or Hyper-V executor paths.

## Explicit non-acceptance gates

No authenticated elevated Broker, signed scoped immutable VMId+host owner grants, independent live `Get-VM -Id` status with attested **provenance/freshness**, physical UAC consent, trusted update/ACL, anti-rollback authority or two-device staged postcondition was tested. Do **not** infer an actual running VM or user approval from a stale `Running` record, `consent.exe`, successful transport ACK, FULL/ROOT/CORE intent or tests. Production privileged Hyper-V remains **NO-GO**. Never replay `Start-VM` on UNKNOWN.

## Repro / results

- `node --test --import tsx test/hyperv-elevation-evidence.test.ts test/qa-02-hyperv-denial-provenance.test.ts test/qa-02-hyperv-unknown-audit.test.ts`: **18 PASS / 0 FAIL / 0 SKIP** on isolated Work PC. Initial negative test expected raw `AGENT_DISCONNECTED`; real MCP correctly normalized it to `MUTATION_STATE_UNKNOWN`. Fixed the *test expectation*, not source or unknown semantics.
- `npm run typecheck`: PASS.
- Exact-head GitHub full CI and human security review **must be checked separately**. No manual CI reruns or live privileged actions.

## Owner CORE correction / integration evidence (2026-10-21)
This independent QA file was originally authored against #618 before the product owner clarified pre-approved elevated ROOT/CORE. On the integration branch, test fixtures now supply a verified ROOT delegation explicitly and assert that an absent *fresh per-operation UAC* is not a reason to block a previously authorized ROOT/CORE session. A rejected physical approval remains a denial, medium token without attested elevated Broker remains denied, UNKNOWN is never replay-safe, forged consent.exe flags and stale/wrong VM state remain untrusted. The original independent error-code, correlation ID, journal persistence and no-replay tests remain enabled. Isolated Windows test suite: 21/21 PASS; TypeScript PASS. This is source-only proof, not a live elevated VM start or a trusted installed Broker.
