# P0 #29 Follow-up: independent readback, two-Hub ACK, rotating audit, revoked CORE

**Source-only stacked QA.** Parent is [#648](https://github.com/Naveax/Nexowire/pull/648) at exact SHA `9d9d11b9326df49d4d1288b24c823f15367bf3eb`; the original 16 tests remain untouched. This child introduces only `test/qa29-rotated-audit-crosshub-negative.test.ts`, this review note and a scoped Node 22/24 CI workflow. No installed Windows components, UAC, native Agent, Broker, ACL, real elevated commands, virtual machines or ReVoltVPN-Ubuntu-Lab touched.

## Verified gap review in #648

1. `classify()` depends on a role-labeled synthetic `postcondition` record with `independent:true` and an HMAC generated inside the test fixture. The record proves source policy under the fixture's assumptions, **not operational independence from a compromised Hub** or that the physical postcondition was measured. The new independent observer owns a distinct disposable Ed25519 test private key, while the validator receives only the public key.
2. #648 duplicate ACK coverage appends to one local instance; it does not crash Hub A and create Hub B with an independently retained request reservation, identical intent fingerprint, and ACK deduplication record.
3. The original single-chain `verifyChain` caps at 64 records and accepts a *provided* signed `Anchor`. It does not check signed segment-to-segment rotations or **retrieve the latest** rollback-independent root. A valid old anchor is not automatically a current anchor.
4. #648 revocation is represented by appending a local `revoke` event, whereas a real CORE revoke/re-pair must be checked against independently current **owner and CORE epochs** even if an old receipt was already signed.

## Added synthetic acceptance

| Boundary | Positive/negative cases | Never assert |
| --- | --- | --- |
| Postcondition | Separate Ed25519 observer public-key verification; altered report/forged `approved:true`; success-text stdout + `exitCode=0` without postcondition; genuine mismatched state; mismatched target/generation/owner/session/epoch/launch nonce; stale or pre-exit readback | That synthetic signatures prove OS high-token or actual state |
| Hub crash / replay | New Hub sharing only external fixture authority; lost ACK then duplicate ACK, unchanged UNKNOWN and no second dispatch; same intent under new requestId fenced; different CORE epoch ACK untrusted; two Hub contenders | A JavaScript Map is durable external CAS |
| Rotation | Three linked segments; signed checkpoints, strict sequence and parent linkage; delete/reorder/tamper/duplicate/truncate; latest independently fetched monotonic witness; missing root fail-closed; empty rotation rejection | Local signature or two co-backed-up SQLite files are rollback independent |
| Revoked CORE | External grant epoch changed after signed readback; post-revoke current-admission status UNKNOWN; revoke between reserve/dispatch; re-pair demands fresh owner/epoch/reservation | That a running process was terminated by revoke |

## Audit schema, secrets, and provenance

The generated fixture never puts raw stdout/stderr, full command bodies, arguments, passwords, API tokens or credentials in audit records. Only fixed labels, requestId, owner/CORE epoch, segment index, monotonic sequence and **opaque hashes over synthetic fixture references** are retained. The synthetic SHA-256 examples are not a privacy assurance: production commitments for low-entropy data need a protected keyed construction plus redaction, access control and data minimization. Neither the test signatures nor its in-memory root are durable production authorities.

**Important temporal semantics:** Revoke stops **new authority**, not time. An existing process may still run, an old historical effect may still have happened, and a fresh independent readback may be necessary to reconcile it. The `unknown` decision after revoke is deliberately an admission/current-verdict result, **not an assertion that the historical action failed or was rolled back**. Similarly, a transport ACK alone is never a mutation result.

## Deterministic source verification

```sh
npm ci
npm run typecheck
node --test --import tsx test/qa29-rotated-audit-crosshub-negative.test.ts
node --test --import tsx test/qa29-elevated-command-audit-provenance.test.ts
```

Independent workflow `.github/workflows/qa29-crosshub-audit-negative.yml` runs TypeScript typecheck and both parent+child source tests on Node 22 and Node 24. Check both jobs for the exact child SHA, never reuse a successful prior run for a changed head. No assertions are skipped.

## Unaccepted production dependencies

- #633 has no installed, signed, operational broad elevated CORE command executor; dispatch remains disabled.
- #621's D1 owner delegation/physical Windows enrollment is not proven by these test-only Ed25519 objects. Re-pair and revocation must be durable and enforced by protected Broker and owner authority.
- #587 requires an independently hosted monotonic CAS/witness with a real failure-mode/backup domain distinct from Agent and Hub. In-memory stand-ins never satisfy it.
- Real high token, approved local UAC enrollment, protected signed binary/import/updater ACL, Authenticode publisher and runtime image, kernel-backed process identity, independent native postcondition and physical canary evidence are **BLOCKED**.

**Disposition:** DRAFT, source QA-only, not production acceptance, no main merge or deployment by this PR. #00 integrator review required.