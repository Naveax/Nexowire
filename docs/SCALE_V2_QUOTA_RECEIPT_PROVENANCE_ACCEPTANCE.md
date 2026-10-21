# Quota #14 source acceptance — receipt provenance, #596 stream and #605 lost ACK

**2026-10-21. Staging-only.** Baseline main `37d68d938b9c94b8647b92fb592a2b30c075427c` contains merged #601. This change is restricted to independent quota source code, test-only receipt fixtures, and a negative-test suite. No Artifact Bridge store (#08), Connection worker (#06), actual Worker/D1, billing service, Free policy, or deployment modifications.

## Verified defect and fix

Previously `StagingArtifactByteBudget` interpreted `durableStorageVerified: true`, `durableDeletionVerified: true`, and `writersStoppedVerified: true` as sufficient runtime evidence. **Any untrusted client JSON mapped into those server-only fields would have spoofed durable completion or cleanup**. For an interrupted stream it could prematurely free the reserved storage, while a late writer might still publish bytes.

A new **server-injected `ArtifactDurableProofVerifier`** is now mandatory in addition to the boolean signals for all receipt-dependent transitions:

- `verifyChunk` independently attests exact owner, device, project, session, request ID, offset, length and chunk SHA before `commitChunk`.
- `verifyFinal` independently attests exact principal/session, whole-file length and final SHA before `finalize`.
- `verifyDeletion` independently attests physical deletion before releasing storage; for `CANCEL_PENDING`, `verifyWriterFence` additionally attests every outstanding writer has been fenced/stopped.
- **No verifier, false/missing proof or wrong principal => fail closed**, with the same reserved bytes, stored offset, request ID and tombstone. User JSON booleans or worker ACKs alone do not mint a proof. Caller code must never build this verifier from user-supplied fields or a client-controlled callback.
- Old tests inject clearly marked **test-only mock evidence**, while the new security suite derives verified facts separately from synthetic store snapshots. This is NOT a claim that real #08 storage receipts are already wired or cryptographically signed.

## Local acceptance matrix

| Negative test | Source evidence |
| --- | --- |
| Client forges deletion, stopped-writer, chunk and whole-file verification flags | Rejected absent independently verified proof |
| #596-like bounded stream packet claims another owner/device/project | No foreign chunk offset/byte admission, and forged receipt rejected |
| #605 ACK disconnect after a durable chunk commit | Second independent SQLite handle returns pre-existing CHUNK_ALREADY_COMMITTED and cannot debit twice |
| New connection/UTC epoch after CANCEL_PENDING | No restart with original root/request ID, no chunk re-admission or early cancellation refund |
| Cleanup after lost ACK | Reservation remains until independent durable deletion and writer-fence proof both pass |
| Verified full-object proof and unrelated owner | Correct owner can complete, another owner can reserve independently, no double release |

Local file-backed SQLite WAL evidence validates the **quota source contract**, not actual #596 streaming, #605 durable transport reconciliation, real disconnection of live Agents, or remote Cloudflare D1 transaction behavior. Current per-chunk limit remains **65,536 bytes**, and total-size/disc quotas remain finite. Test-only synthetic connection epochs are not an authenticated live session/transport epoch.

## Release blockers

1. #08 must supply authoritative immutable chunk/full-file/storage deletion receipts including owner/device/project and any durable store epoch; #06/#605 must supply a **trusted** writer-fence/revocation attestation bound to the same generation before disk quota may be released. A staging callback which always returns true cannot be used in production.
2. A verifier reading a separate remote store is not, by itself, a transaction across two independent databases. Races, stale replicas, co-rollback, forged but syntactically valid receipts, and physical cancellation need independent review and fail-closed tests. The present guard is source-only and **not a production authorization gate**.
3. No isolated Cloudflare staging account ID, token, D1 UUID, or approved endpoint was observed on Naveax/work-pc; real Workers/D1 atomic acceptance remains **BLOCKED**. The read-only preflight reports `liveD1Tested:false`. No actual Cloudflare cost acceptance.
4. **Production billing remains OFF.** The operative Free allowance is **1,000 weighted credits per UTC month**, including existing verified repo-owner exception; 5x special-skill weighting remains. Free/Plus/Pro future daily 1,000/5,000/10,000 proposals remain dormant. No live invoice, checkout, subscription, quota migration, or paid resource activation.

**Do not merge as a substitute for real physical #596/#605 or remote D1 acceptance.** Keep the independent PR DRAFT and request security review from the Artifact Bridge, Connection, and main integrator owners.
