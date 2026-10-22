# #02 narrow ACK vs immutable effect readback and scoped capability QA

Date: 2026-10-22. Owner PR: [#727](https://github.com/Naveax/Nexowire/pull/727), existing QA branch only; no duplicate PR. Parent pre-change exact HEAD `47900da1479b80570543bf4971cdfa789bd56ac5`: [full CI #39735429076](https://github.com/Naveax/Nexowire/actions/runs/39735429076) **7/7 SUCCESS**, [DPAPI QA #39735429140](https://github.com/Naveax/Nexowire/actions/runs/39735429140) **SUCCESS**. These historical green outcomes do not certify the new commit.

## Independent cross-owner truth check

- [#754](https://github.com/Naveax/Nexowire/pull/754) exact `3a5bf392109d17dbf2650a18398917d5501fd488`: [CI #39736052869](https://github.com/Naveax/Nexowire/actions/runs/39736052869) **FAILURE solely Windows `browser-live`** at **unchanged** `test/windows-job-owner.test.ts:216`, **iteration 6**, `exited` appeared before stdout payload. Six other CI jobs succeeded. Do **not** attribute this CI failure to the new final receipt tests, nor delete/skip or change #03 Windows Job assertions.
- #754 receipt source/test scope: a Native publish ACK alone must never become `COMPLETED`; separately trusted receipt verifier, exact durable requestId/owner/project/destination/epoch/bytes/SHA binding, independent full destination hash, fresh grants/lease are required. All claims are synthetic until actual Native signer and OS authority exist. #02 does not modify #08 Artifact source.
- [#757](https://github.com/Naveax/Nexowire/pull/757) exact `93acbb7a4e830485ce94015b3c76837a3fcdad34`: [CI #39736445337](https://github.com/Naveax/Nexowire/actions/runs/39736445337) **7/7 SUCCESS**. #04 checks fresh post-permit signed CAS `revoking:false` and `revoked:false` and ownerEpoch/nonce twice across async review; a once-valid signed permit delivered after remote revoke start is denied **source only**. Even successful Access review returns `CURRENT_SOURCE_ONLY_NO_EXECUTION`, not an authenticated Native effect. The post-review-to-effect atomic race is still a separate #01 external CAS problem.

## Only uncovered #02 owner-protocol delta

The existing `src/protocol/elevated-outcome-error-contract.ts` already correctly rejects ACK-only and generic shell using `vmReadback`, with persistent `MUTATION_STATE_UNKNOWN`. What it could not separately express was a **claimed immutable SHA-scoped target readback**: exact request/action/target binding and contradictions between a self-reported VM state and a separately labelled digest candidate.

Narrow non-executing extension (not integrated with Broker/VM):
- Optional `immutableVmEffect` STRICT UNTRUSTED candidate with exact requestId, operationId, owner/device, ownerEpoch, `hyperv.vm.start|hyperv.vm.stop` capability, VMId, claimed VM state, SHA-256-shaped digest, observation time.
- A VM claim for generic `core.shell.exec` is `POSTCONDITION_NOT_APPLICABLE`, regardless of ACK or digest. A start receipt replayed for stop is `POSTCONDITION_CAPABILITY_MISMATCH`.
- Foreign request/owner/device/VMId/epoch is `POSTCONDITION_IDENTITY_MISMATCH`; old receipt is `POSTCONDITION_STALE`; conflicting claimed VM state and observed state is `POSTCONDITION_RECEIPT_INCONSISTENT`; malformed digest is strict `FORGED_OR_INVALID_OBSERVATION`.
- **Even completely matching ACK `transportOk:true`, `exitCode:0`, claimed immutable SHA digest and VM `Running` stays `POSTCONDITION_NATIVE_ATTESTATION_MISSING` / `MUTATION_STATE_UNKNOWN` / `effectVerified:false` / `reconcile_first` / `automaticallyRetryable:false`**. SHA-shaped data is not a cryptographically trusted independent receipt. No real effect verifier or success path is added.

Only **two new source-negative tests** in `test/qa-02-754-757-immutable-effect-scope.test.ts`, plus the #02 protocol helper and QA-only workflow list, and this report. All original six cross-owner #02 negatives and past DPAPI/owner tests preserved unchanged. Local focused **17/17 PASS**, `npm run typecheck` PASS; broader tests and **new exact-head CI** must be checked separately.

## Explicit non-acceptance

No live elevated commands/UAC/Start-VM, no Agent/Broker/ACL/production/main modification, no #03/#04/#08 implementation changes. #754 target publication, #757 revoke and #712 atomic dispatch are distinct trust boundaries. Signed protected installed HIGH Broker, externally monotonic CAS, actual fresh native readback and physical owner approval remain production **NO-GO**. This #02 helper cannot validate a signature or prove immutable output merely because the payload contains a SHA.
