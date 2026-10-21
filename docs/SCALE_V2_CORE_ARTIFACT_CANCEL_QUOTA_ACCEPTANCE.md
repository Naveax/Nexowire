# Quota #14 | CORE owner/device, receipt and UNKNOWN source compatibility

2026-10-21. Independent source-only staging acceptance child of OPEN #610
(which itself is based on main `4c5c810134c020cd04a5ef2be5c1138ea1954ad0`).
No installed Agent, CORE helper, D1, artifact store, real file, payment
provider, or billing state was modified.

## Exact review findings

- #601 **MERGED** in main.
- #610 HEAD `3064acdf18b0817ecf3650ec7d61f9233d36a009`, exact-head CI **SUCCESS**.
- #596 HEAD `335046569a38f3a1a3fc82bf851f9b7df7640fdb`, exact-head CI **SUCCESS**.
- #616 HEAD `94b92e01219aca3cd4ca86775fe4b61a72ac53c4`, exact-head CI **SUCCESS**.
- These independent successes **do not** prove the assembled stack. In an
  isolated private Windows worktree, #610 was cherry-picked over #616:
  exact composite HEAD `399c20fdf0674a64e37ffb0c0cbde9b396706bae`.
  `npm run typecheck` PASS; `test/artifact-store-job-failclosed.test.ts`
  **4 PASS / 1 FAIL** because #616's old synthetic
  `VerifiedWriterDeletion.attest` returns two literal `true` flags but
  does **not** supply the independently injected #610
  `ArtifactDurableProofVerifier`. Failure:
  `TRUSTED_DELETION_EVIDENCE_REQUIRED`. This is desirable fail-closed
  behavior, **not** a request to disable the guard or skip the test.
- #616 must wire authoritative #08 immutable storage deletion proof and #587
  or #605 epoch-based writer-fence attestation to the same trusted
  server-injected proof verifier. Mock proofs are permitted only inside
  explicitly isolated tests. The real #616 job/budget code remains owned
  by #08 and is not edited in this PR.

## Independent CORE cancellation acceptance design

This child adds staging-only `StagingCoreArtifactCancellationGate`, **not**
a Windows elevated execution path, UAC implementation or production route.
Its trusted job binding must be loaded from authorized server-held job state,
not the incoming MCP payload. It rejects without mutating quota unless the
trusted authority executes the mutation inside a **current owner/device
delegation lease** and the proof matches:
- Exact authenticated owner, device, project and session;
- Matching positive owner and device epochs, not stale re-pair or revoked grant;
- Effective CORE (not a FULL preference field), high token integrity;
- Verified Broker code signature and protected Broker identity;
- Known current delegation, never `UNKNOWN`, and not revoked;
- Exact committed byte offset compare-and-set.

The authority's `withVerifiedCoreLease` MUST hold the external monotonic
lease for the duration of the callback or fail closed. A fabricated object
or a verifier that merely returns a user-supplied high-integrity string
is insecure. This staging contract is not a credential or proof that live
CORE elevation is installed.

## Retry, dishonest receipt, cross-epoch and fairness

Dedicated source fixtures use two SQLite WAL handles and an **independent
synthetic authority**, never real Hub, #596 worker or #616 store. They verify:

1. No CORE authority or invalid proof cannot cancel.
2. Medium token, unsigned/unprotected Broker, or FULL preference cannot
   impersonate elevated CORE.
3. Wrong owner, device, project and session are denied.
4. Owner epoch changed, device re-pair, revocation or UNKNOWN fails closed.
5. A forged client-provided `writersStoppedVerified`,
   `durableDeletionVerified` or `durableStorageVerified` boolean
   cannot release reserved storage or complete a chunk; independent
   durable store/lease evidence is required by #610.
6. Lost ACK following one durable chunk commit returns
   `CHUNK_ALREADY_COMMITTED` on a different SQLite handle without
   double byte debit.
7. After cancellation a late ACK, replay, or new synthetic connection
   epoch cannot revive old request IDs or refund the minute byte debit.
8. Other authenticated owners remain isolated and able to reserve
   independently. Cancellation frees disk reservations only after
   verified writer-stop **and** independently verified deletion.

No physical cancellation, writer stoppage, UAC confirmation, multi-Hub
integration, Cloudflare distributed write, authenticated real CORE token or
actual storage cost was tested.

## Acceptance status and unchanged policy

| Gate | Status |
| --- | --- |
| Own isolated CORE quota source tests | PASS on synthetic fixtures |
| Prior #610 quota cancellation and receipt tests | PASS |
| #616 + #610 combined contract | FAIL CLOSED on missing verifier |
| Actual #596/#616/#605 integrated writer/drop/lease proof | **BLOCKED** |
| Remote Cloudflare Workers/D1 | **BLOCKED**: no authorized isolated staging account, database ID, scoped token or Worker URL |
| Production CORE elevation and billing | **NOT TESTED / OFF** |
| Real disk/Cloudflare costs | **NOT TESTED** |

**Production Free remains 1,000 weighted credits per UTC month**, including
the existing verified repo-owner exception and special-skill multiplier.
Future daily Free 1,000 / Plus 5,000 / Pro 10,000 proposal entitlements are
dormant. No invoice, checkout, subscription, mutation of user quota,
production migration, live Agent service change or unlimited MCP envelope
was introduced. Keep all new work DRAFT for #08/#06/#00 review.
