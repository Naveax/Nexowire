# NEXOWIRE P0 #25: signed witness and postcondition adverse acceptance

**SOURCE-ONLY / DRAFT / NO LIVE PRIVILEGED DISPATCH / PRODUCTION NO-GO.**

## Verified parent and isolated scope

- Parent #654: exact HEAD f369683a0c164d9cb3ef679956062298b021feb1.
- Parent GitHub Actions workflow 39630142422: completed / success, all 7 jobs success, checked 2026-10-21.
- Parent #654 is based on #643, which is based on #633. This QA is a separate new child of #654, not an edit to #03/#04/#01 owners' implementation.
- Added test: test/core-signed-postcondition-root-boundary.adversarial.test.ts.
- This document and the test are the complete intended diff. No native elevated shell, Broker, Agent, Windows services, UAC, VM, installed executables, production signer, ACL or ReVoltVPN-Ubuntu-Lab actions.

## Trust and signature model

The test has **two locally generated Ed25519 keypairs**, one for a mock witness and one for a mock postcondition observer, plus an unrelated attacker keypair. Signatures bind event category, protocol domain, issuer identity, requestId, deviceId, ownerAccountId, ownerEpoch, credential binding, grant generation, session epoch, action digest, launchId, sequence/timestamp and the effect observation. Verifiers pin separate public keys, canonical base64url format and exact signed field inventories, including nested scope. Cross-protocol signature reuse and unsigned metadata injection are negative cases.

The in-memory TestOnlyEvidenceOracle and all signatures are **synthetic**. A test-generated private key, even when Ed25519 verifies, is not a real independently trusted Windows/OS witness or off-process monotonic CAS. The test verifies the shape and adversarial behavior expected from a future production integration; it does not prove any elevated command ran, any native OS effect happened, or any cancellation succeeded.

The current real source contract remains CORE_EXECUTOR_DISPATCH_ENABLED=false. The existing evaluateCoreBrokerExecution function is explicitly re-entered for admission checks. Its synthetic runtime flags do not constitute actual high-integrity Windows token evidence, installer approval or Authenticode/ACL validation.

## Acceptance matrix

| Adversarial sequence | Expected source-only result | Production status |
| --- | --- | --- |
| Revoke before dispatch | Initial reservation; revoke denies dispatch; only an independently signed **never-dispatched** witness may establish CANCELLED_NO_EFFECT | Requires external atomic no-send proof |
| Signed dispatch receipt, then owner revoke before postcondition | MUTATION_UNKNOWN, no replay; revoked admission is not no-effect proof | Requires OS/native dispatch journal and independent observation |
| Duplicate lost ACK, cancel/reconnect or replay | RequestId remains globally reserved across re-pair; no second launch | Requires off-process persistent monotonic CAS |
| Wrong signer/issuer, altered fields, nested unsigned fields or protocol replay | Denied before effect promotion | Real public-key provenance and immutable log are unverified |
| Re-pair changes owner/epoch, session and generation | Old effect receipt remains attributed to old scope; old requestId cannot be reused by new owner | Real cross-Hub owner/session grant fencing unverified |
| Forged/wrong-grant, old session, wrong launchId, bad digest, broker/client claimed postcondition | No transition from MUTATION_UNKNOWN | Real independently authenticated readback missing |
| **Signed** EFFECT observed by synthetic independent observer | Historical EFFECT_VERIFIED, never CANCELLED, even after later revoke | Does not prove real physical effect |
| **Signed** NO_EFFECT claim after dispatched task | Still MUTATION_UNKNOWN: signature by itself cannot reverse side effects | Real no-effect evidence and write barrier missing |
| ROOT boundary at T+899999ms | Synthetically signed dispatch may commit before expiry | Real server-clock monotonic fence unverified |
| ROOT at T+900000ms or backdated signature after deadline | New dispatch denied, signed no-dispatch required to claim cancellation; existing launched mutation remains UNKNOWN | Actual native deadline enforcement missing |
| Multiple owner-enrolled CORE requests | Source admits typed preapproved actions without per-command UAC; dispatch disabled | Real once-approved protected high-integrity Broker missing |

## Important product and evidence distinction

The #633 source gate checks ownerRevoked before pendingMutationUnknown; with both set it returns GRANT_REVOKED. This is **authorization for future work**, not evidence that a previously dispatched side effect did not occur. The result's privilegedExecutionOccurred:false is also inherent to source-only disabled dispatch. Neither field is a cancellation/postcondition receipt.

The expected production state is a **pair of independent truths**:

1. Authorization: current owner/device credential, generation/session epoch, CORE or ROOT grant; revoke/expiration block additional dispatch.
2. Effect: RESERVED_NO_DISPATCH, MUTATION_UNKNOWN after possible dispatch, independently VERIFIED_EFFECT or verified no-effect with real authoritative readback; never infer either from revoke/timeout/kill/exitCode/ACK alone.

The synthetic oracle deliberately treats post-dispatch NO_EFFECT as insufficient even if signed, because a signature without verified independent physical observation and durable pre-effect journaling does not prove undo or zero side effects.

## Production integration NO-GO items (not implemented here)

1. Off-process atomic witness CAS with globally unique requestId, owner/device/credential, grant generation, session epoch, immutable dispatched/effect receipts and protection against clock rollback.
2. Signed protected Windows Broker, actual high token and Administrators enabled, certificate publisher pin, import/parent/updater ACL, PID+creation identity.
3. Native fence at each irreversible effect boundary. Revoke before fence means no dispatch; after possible dispatch requires UNKNOWN until authenticated physical reconciliation, including when process termination succeeds.
4. ROOT maximum 15 minutes enforced by an authoritative monotonic clock; queued or repeated request cannot extend it. CORE stays persistent only for valid owner-approved enrollment and does not require fresh UAC for each command.
5. Real owner intent/signed admission and producer-separated postcondition observer; OS state hash/output readback attached to old historical request scope. Existing source request schema has no explicit sessionEpoch or grantGeneration field; test-only signed records are not a production substitute.

## Reproduction (Node.js 22/24; no shell elevation)

~~~sh
npm ci
node --test --import tsx test/core-signed-postcondition-root-boundary.adversarial.test.ts
node --test --import tsx test/core-owner-postlaunch-unknown.adversarial.test.ts
node --test --import tsx test/core-owner-revoke-mid-execution.adversarial.test.ts
npm run typecheck
~~~

All outcomes are **source test evidence only**. Green CI must not be interpreted as production CORE acceptance or permission to install/activate elevated dispatch.