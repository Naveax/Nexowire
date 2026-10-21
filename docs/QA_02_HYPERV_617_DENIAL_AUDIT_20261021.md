# #617 Hyper-V / Admin Bridge: independent Error Contract QA evidence

Date: 21 October 2026. Owner: #02 Error Contract QA. Original acceptance parent: [DRAFT #618](https://github.com/Naveax/Nexowire/pull/618) at `14d0d6f71ea2284c0f17a14e947f24d999aade37`. **Current reconciled parent:** `512a1764d65efbfb448577687225d71e3a845a8d` (details in final reconciliation section).

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
- All existing #618 source and its tests remain unchanged (8 at original parent, 11 at current CORE-enabled parent). The #02 PR must not change `src/agent/process-manager.ts`, `src/agent/privileged-broker.ts`, `src/protocol/hyperv-elevation-evidence.ts`, Windows UAC or Hyper-V executor paths.

## Explicit non-acceptance gates

No authenticated elevated Broker, signed scoped immutable VMId+host owner grants, independent live `Get-VM -Id` status with attested **provenance/freshness**, physical UAC consent, trusted update/ACL, anti-rollback authority or two-device staged postcondition was tested. Do **not** infer an actual running VM or user approval from a stale `Running` record, `consent.exe`, successful transport ACK, FULL/ROOT/CORE intent or tests. Production privileged Hyper-V remains **NO-GO**. Never replay `Start-VM` on UNKNOWN.

## Repro / results

- `node --test --import tsx test/hyperv-elevation-evidence.test.ts test/qa-02-hyperv-denial-provenance.test.ts test/qa-02-hyperv-unknown-audit.test.ts`: **18 PASS / 0 FAIL / 0 SKIP** on isolated Work PC. Initial negative test expected raw `AGENT_DISCONNECTED`; real MCP correctly normalized it to `MUTATION_STATE_UNKNOWN`. Fixed the *test expectation*, not source or unknown semantics.
- `npm run typecheck`: PASS.
- Exact-head GitHub full CI and human security review **must be checked separately**. No manual CI reruns or live privileged actions.

## 21 October CORE model reconciliation: parent #618 HEAD 512a176

This is the **current** acceptance update; the original 14d0d6f/18-test section above is historical. Parent #618 at `512a1764d65efbfb448577687225d71e3a845a8d` introduced required `ownerGrant`, `rootLease`, `coreEnrollment`, and `delegation.perOperationUacRequired`. Merged parent source unchanged into QA #619. The original ten QA02 cases remain present, with only fixture fields added and the previous `localApproval:not_verified => pending` test reconciled to **preapproved ROOT/CORE needs no new per-command UAC**. When Broker is not attested, the status correctly remains `denied/windows`, not a fake fresh UAC consent request.

New `test/qa-02-core-grant-epoch-provenance.test.ts` tests six explicit distinctions:
1. Verified pre-approved CORE + authenticated, version-matched **high Broker** => `core-preapproved`, `perOperationUacRequired:false`; Agent may remain Medium integrity. Execution in this *source-only* description is `pending` awaiting independent postcondition, NOT `succeeded`.
2. Verified ROOT lease similarly has no operation-by-operation UAC; expired/unverified ROOT denies even if a CORE flag exists for a different requested mode.
3. SAFE/FULL mode and caller-forged `approved:true`/consent.exe cannot acquire elevated rights from a Broker being available.
4. Revoked/unverified CORE enrollment due to stale owner epoch denies even with a verified Broker.
5. Dispatched/lost acknowledgement with valid CORE/Broker remains `MUTATION_STATE_UNKNOWN`, no retry, no success from old `Running` or consent.exe.
6. Real `IdempotencyStore` synthetic reservation: previous ownerEpoch 4 `unknown` operation returns the original requestId on same-key recovery; a changed epoch 5 fingerprint with the **same key** rejects `IDEMPOTENCY_KEY_REUSED`. This tests journal fingerprinting, **not** an implemented Hyper-V executor or independent monotonic epoch attestation.

**Important unresolved limitation:** the #618 projection has NO trusted `ownerEpoch` / paired epoch / signed owner credential fields. The revoked/unverified source test represents the output of a **hypothetical separate protected epoch verifier**. Injected `ownerEpoch` and `currentOwnerEpoch` fields are *ignored* by the explanation function. If an upstream caller falsely supplies `coreEnrollment:'verified'` with a stale epoch, the source-only delegation label can still say `core-preapproved`, although `effectVerified:false` remains fail-closed. This is an **explicit release blocker**, not a passed proof of durable owner binding. #323/#322/#587 owners must implement current signed owner/device/epoch attestation and rollback-safe revoke before dispatch.

**Invariant:** `consent.exe` existence, a remote UAC button, arbitrary CORE preference and a successful RPC ACK never attest real UAC consent, a high Windows token, or a physical VM `Running` state. Once a legitimate signed Broker was installed and a *truly independently verified* CORE delegation is current, repeat per-command UAC is not required; a bootstrap/owner enrollment UAC is distinct. #617 physical acceptance, protected installer/ACL (#551/#271), authenticated Broker, device/epoch binding, VM state provenance and human security approval remain NO-GO.

Current focused source-only QA on parent `512a176` plus all QA changes: **27/27 PASS, 0 FAIL, 0 SKIP**, `npm run typecheck` PASS. Broad local test suite and new exact-head CI are tracked separately. No live VM/UAC/ACL/Agent/Hub/Broker mutations.
