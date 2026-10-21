# P0 #25: Two-Hub external CAS and Access handoff adversarial QA

**DRAFT / SOURCE ONLY / PRODUCTION HIGH BROKER NO-GO**

## Reviewed exact owner references (2026-10-22)

| Source | Inspected HEAD | Exact GitHub Actions |
| --- | --- | --- |
| #716, worker #25 parent | `0ca5903fae851bed44ddc14e4c2c464c769d6723` | 39659320381 completed SUCCESS, 7/7 |
| #712, #01 external CAS dispatch fence | `62800af17d2a9ce18670dba6a8ac861a5d7f4ba5` | 39659225895 completed SUCCESS |
| #719, #04 effective queued Access | `597191102dabc22e22c7f9822a026bbd12d60c52` | 39659394811 completed SUCCESS |

#712 owns `BrokerExternalDispatchFence` and `HttpsBrokerDispatchAuthority`.
Its source obtains a short-lived Ed25519 permit from an external authority,
checks broker owner epoch/generation and challengeNonce, then invokes a
provided callback. It calls `release` in `finally`. A successful release,
revoke drain or callback exit is NOT a physical irreversible-effect readback.
The external service and physical native dispatch fence are undeployed.

#719 owns `reviewQueuedAccess`, which performs read-only EFFECTIVE status,
signed external CAS readback and independent high-water checks. The result
`REVIEWED_ONLY_NO_DISPATCH` explicitly has
`elevatedDispatchAllowed: false`. A request with
`effectState: 'may-have-dispatched'` returns
`UNKNOWN_RECONCILE` with `canRetry: false`.
A previous projection or cached UI setting is not a dispatch grant.

These source branches are DIFFERENT, unmerged owner stacks. This #25 test
imports the shared #633 `evaluateCoreBrokerExecution` source already
present on #716, but **does not import #712/#719 owner implementations**.
It is an independent source-only cross-contract *specification oracle*,
not an end-to-end integration of those owners and not proof of a real CAS.
Do not label the simulated Hub or the in-memory map as deployed/external.

## New adversarial coverage, not duplicates of #716

- **Two Hub race, same requestId:** both see a prior positive read-only
  projection but a shared monotonic CAS permits exactly one reservation,
  and one synthetic effect. Never create one ledger per Hub.
- **Revoke after Access review, before atomic CAS reserve:** fresh reviewer
  optimism becomes stale; actual reservation rejects after generation moves.
- **Revoke after reservation, before native effect fence:** no dispatch.
  `CANCELLED_NO_EFFECT` is only acceptable with authenticated no-send
  evidence; a cancel command without readback is not proof.
- **Irreversible synthetic effect committed on Hub A; revokeAndDrain ACK and
  observer readback lost on Hub B:** state stays `MUTATION_UNKNOWN`, never
  `CANCELLED` or completed, never automatic replay despite duplicate ACK.
- **Foreign owner re-pair / Hub failover:** old owner epoch, credential,
  session and generation do not grant new owner permission. A globally used
  requestId cannot be reserved again even under the newly enrolled owner.
  An old but correctly Ed25519-signed permit is NOT current owner authority.
- **ROOT 15-minute deadline:** permit reserved/signed at T+899999ms
  expires for dispatch at T+900000ms; native fence must recheck. A synthetic
  effect committed at T-1 is not undone when ROOT expires at T.
- **Immutable independent postcondition unavailable:** no observer receipt,
  signer mismatch, altered digest/objectId/launch binding, or offline
  witness prevents `EFFECT_VERIFIED` and leaves `MUTATION_UNKNOWN`.
- **Preapproved CORE:** multiple separate requests still require no
  per-command UAC; `CORE_EXECUTOR_DISPATCH_ENABLED=false` in actual source.

## Trust/provenance limitations

All grants, CAS state, Ed25519 keys, two Hub views, signed permits, effect
markers and readback receipts are **in-memory test fixtures**. The synthetic
`syntheticLaunches` array represents no OS or irreversible mutation.
Cryptographic signature verification is real, but signing an invented
result is not an independent authenticated physical readback.

A production implementation must provide durable globally unique requestId,
independent monotonic owner/grant/session/credential high-water, native
pre-effect atomic fence, protected high-integrity Broker, real authenticated
immutable readback (including native PID+creation identity where relevant),
and split authorization state from side-effect state. A successful
`revokeAndDrain` does NOT mean pre-existing side effects were undone.
The user must not be asked to approve UAC for every already-enrolled CORE
command. No physical CORE launch is authorized by these source tests.

## New QA-only files

- `test/core-two-hub-owner-revoke-cas-postcondition.qa.test.ts`
- `docs/CORE_TWO_HUB_CAS_REVOKE_READBACK_QA_20261022.md`

No modification of #01, #03 or #04 owner implementation, Agent/Broker
files, ACLs, live service, elevated shell, VM or ReVoltVPN-Ubuntu-Lab.

## Reproduce

```sh
npm ci
node --test --import tsx test/core-two-hub-owner-revoke-cas-postcondition.qa.test.ts
npm run typecheck
```

Source test PASS is not production physical acceptance. External CAS,
native signed Broker, physical revocation and immutable OS effect readback
remain **NO-GO** pending separate independent integration.
