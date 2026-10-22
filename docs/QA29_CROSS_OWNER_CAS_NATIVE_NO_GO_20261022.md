# QA29: #712 CAS permit vs #709 native protected Broker, cross-owner negatives

**Scope:** source-only compatibility/negative QA, stacked on PR #699 exact parent `c7c868edfa788ded1990a6c03c2a7d527a3b66d8`. No #01/#03/#04 implementation edits and no real signed/elevated process; **not an integrated compile of sibling owner branches**. Sibling refs independently inspected:
- [#712](https://github.com/Naveax/Nexowire/pull/712) at `1d78a7a9174e91e3b6baaa1319a063917391a64f`; source `src/agent/broker-external-dispatch-fence.ts`, `src/agent/https-broker-dispatch-authority.ts`; exact CI [39676838080](https://github.com/Naveax/Nexowire/actions/runs/39676838080) SUCCESS.
- [#709](https://github.com/Naveax/Nexowire/pull/709) at `b083004b9ab8c18125a428cf74f3e97f7adf4e88`; source `scripts/audit-core-broker-protected-tree.ps1` and `src/security/core-broker-process-witness.ts`; exact CI [39658979397](https://github.com/Naveax/Nexowire/actions/runs/39658979397) SUCCESS.
- [#699](https://github.com/Naveax/Nexowire/pull/699) parent source QA exact `c7c868edfa788ded1990a6c03c2a7d527a3b66d8`; dedicated run [39658654826](https://github.com/Naveax/Nexowire/actions/runs/39658654826) and **full 7/7** [39658654687](https://github.com/Naveax/Nexowire/actions/runs/39658654687), BOTH SUCCESS.

## Genuinely uncovered QA cross-owner gap

The parent receipt-only fixture signs synthetic OS PID/FILETIME and independently signed postcondition but **does not require the actual #712 cryptographic challenge/remote permit and #709 native protected-tree/handle evidence** in a single admission. An owner might misinterpret a source receipt result `COMPLETED_VERIFIED` as physical elevated execution authorization.

`test/qa29-cas-native-bridge-negative.test.ts` adds only targeted cross-boundary assertions:

1. #712 Ed25519 **base64url** signed `broker_dispatch_permit_v1` must bind full owner/device/session/deviceEpoch, independent numeric `ownerEpoch`, grant `generation`, broker ID, capability, requestId, 64-char challengeNonce, fingerprint and TTL. Stale signed claim, changed nonce after simulated restart, wrong signer, noncanonical base64, injected fields, expiry/clock skew and wrong grant generation reject.
2. **CORE epoch is not grant generation.** The OS process/readback receipt's CORE epoch is separately bound against a synthetic current CORE epoch, while #712 signed permit uses grant generation. Revoke of owner, CORE or generation fails closed.
3. Independently signed OS process and readback cannot swap trust keys. PID + exact Windows creation FILETIME + boot ID + launchNonce + reservationNonce + owner/device + intended command digest must match. Transport ACK after possible native effect never enables retry.
4. #709 actual script returns `kind:windows_core_broker_protected_tree_readonly_v2`, `productionReady:false`, `elevatedCoreDispatchEnabled:false`, `pidCreationFiletimeVerified:false`, `protectedCompleteImageTreeAttested:false`, `importListIndependentlyEnumerated:false`. Its ACL evidence may detect genuine unsafe paths in disposable fixtures but does **not** attest a complete signed runtime/high-token Broker. Even a correctly signed #712 permit plus synthetic #699 OS/postcondition evidence **must remain MUTATION_UNKNOWN / no production elevation** until separately installed native provider.
5. Redaction boundary strips password, authorization token, raw stdout and argv from persisted audit projections and result reasons.

This new QA test is **a pinned, manually reviewed contract fixture**, not an import of #709 or #712 implementation: the siblings are stacked against separate owner branches and absent from #699's source tree. Updating any owner source schema requires repeating the comparison. It tests bad interpretation and schema drift scenarios, **not an end-to-end integration of their runtime modules**.

## Repro / gates

```sh
npm ci
npm run typecheck
node --test --import tsx test/qa29-elevated-command-audit-provenance.test.ts test/qa29-rotated-audit-crosshub-negative.test.ts test/qa29-native-receipt-verifier.test.ts test/qa29-cas-native-bridge-negative.test.ts
```

Dedicated Node 22/24 workflow runs 56 inherited source-only cases plus 12 new source contract negative tests. GitHub exact-HEAD CI is required before reporting PASS.

**Production NO-GO**: no physically trusted Windows HIGH token provider, import closure, signed protected broker installer, handle/DACL witness, independently durable external CAS or actual postcondition canary is proven here. No live shell, UAC, ACL mutation, Agent, Broker or VM. Keep DRAFT and let integrator #00 reconcile owner PR branches without overwriting them.
