# QA #17 continuation: Windows Broker native provider availability and queued revoke

**Issue:** #617. **Source-only / NOT production accepted.** This branch is stacked on #635 (which is stacked on #633), without changing the #03 or #12 implementation.

## Exact contract boundary

- #633 `src/security/core-broker-executor-contract.ts` currently gates broad CORE/ROOT actions on caller-supplied `CoreBrokerContext` booleans and **always** returns `ELEVATED_DISPATCH_NOT_INSTALLED` for an all-green fixture. It is not an installed Broker.
- #632 `scripts/s3-core-bootstrap-delegation-audit.ts` separately requires OS-authorized local consent, signed owner/command intent, SYSTEM Task Scheduler principal, native token RID / Administrators enabled, pinned publisher/image identity, protected ancestors/imports/updaters, protected DPAPI owner key and witnessed stop/revoke readback. This stacked PR does **not** import or modify #632 implementation: #632 is on a different parent branch. #636 exercises its real source implementation. Cross-stack integration and a physically authenticated provider are still missing.
- The new `test/qa-17-provider-unavailable-queued-revoke.test.ts` is an independently authored **synthetic input translation harness**. It does not create cryptographically verifiable native attestations. In particular, the text value `independent-windows-native` cannot by itself prove an OS provider.

## Negative cases covered

- Publisher `UNAVAILABLE`, invalid signer despite a matching alleged pin, absent out-of-band publisher pin.
- ACL `UNAVAILABLE` with unknown broad-write state `null`, including an attacker reporting `false` while provider is unavailable; inherited broad write, unprotected parent and importer/updater gaps.
- Missing token provider, medium integrity, TokenElevation absent, deny-only/disabled Administrators group, wrong SYSTEM principal, insufficient Task run level, self-reported elevation, absent RID.
- Missing running image handle/process creation identity, replaced image, unauthenticated Broker version, unsafe duplicate-handle boundary, unsigned rollback.
- Queued command followed by owner revocation, credential/owner epoch re-pair, ROOT expiration, UNKNOWN mutation acknowledgment and duplicate ledger reservation.
- A simulated owner epoch rotation **inside the replay lookup** illustrates a current ordering risk: #633 checks the epoch before invoking the replay ledger, not again after. The current source gate still denies as `ELEVATED_DISPATCH_NOT_INSTALLED`. This is a **follow-up integration requirement**, not evidence of safe post-reservation dispatch. A future executor MUST independently recheck the owner epoch immediately before side effect, using external monotonic fencing.

## Production NO-GO

`CORE_EXECUTOR_DISPATCH_ENABLED=false`. No live elevated shell, real signature/provider proof, task/service, physical local UAC, device approval, protected installer/DPAPI, native Broker token, independent postcondition or Hyper-V mutation tested. Tests here are not real Windows elevated execution evidence. #271 privileged writable tree remains a release blocker.

No Agent, Broker, ACL, UAC, Windows service, personal files or VM touched. `ReVoltVPN-Ubuntu-Lab` is excluded.
