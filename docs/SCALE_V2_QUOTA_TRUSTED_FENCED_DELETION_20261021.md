# Quota #14 | Trusted fenced deletion release adapter (21 October 2026)

**STAGING SOURCE ONLY; CHILD OF DRAFT #625.** No Artifact Bridge store, #08 transfer worker, QA #21 files, live elevated Broker, Cloudflare D1, installed Agent, user files, payment or invoice was touched.

## Review of actual source and exact workflow

- Main at start of review: 754cc4364822be5fda528f54042fb22a84f19924.
- #601 MERGED. #610 HEAD 3064acdf18b0817ecf3650ec7d61f9233d36a009, exact CI SUCCESS.
- #625 HEAD 2ae3f0c94b1c3afd3fa3b5e70a5c8dca56a798a8, exact CI **39608704634 FAILURE**, Windows Job fast-exit output capture. Do not call this PASS or no-run.
- #616 HEAD 94b92e01219aca3cd4ca86775fe4b61a72ac53c4, #634 HEAD 9266f9b65a1f193360469223360552a50892949a, #640 HEAD 91f1426f5378bc2eaf3a680a7f7e067f8d4eba73. #08/#21 owner chains were left untouched.
- Separate #616+#610 composite HEAD 399c20fdf0674a64e37ffb0c0cbde9b396706bae: Typecheck PASS, artifact-store-job-failclosed.test.ts **4 PASS / 1 FAIL**, TRUSTED_DELETION_EVIDENCE_REQUIRED. The old #616 test supplied two true flags instead of an independent durable proof. **Do not skip or downgrade this security failure**.

## Implemented trusted cleanup admission contract

The new source-only StagingArtifactFencedCleanupAdmission takes only a trusted server-loaded owner/device/project/session/root binding and current owner/device/dispatched-writer epochs. **There is no input for client booleans.**

1. Protected external authority MUST hold a rollback-independent writer-fence CAS lock across the callback, including Promise resolution and the budget transaction. It must independently establish that all dispatched native writers stopped, including writes whose ACK was lost, and verify physical stage deletion. Simply seeing job.state CANCELLED, SUCCESS, no bytes confirmed, or a client JSON flag is insufficient.
2. Under that held fence, the signed/protected, high-integrity CURRENT CORE owner/device delegation is checked. Medium, revoked, stale re-pair, UNKNOWN, and wrong owner/device/project/session are rejected.
3. The independent deletion witness must match full scope, root ID, owner epoch and device epoch; its stopped-through writer epoch must meet/exceed the highest dispatched writer generation. Deletion and fencing generations must be monotonic.
4. Only then does the adapter construct internal verified flags and call the existing #610 quota ledger. The ledger still independently requires an injected trusted durable deletion AND writer-fence proof verifier, otherwise it throws TRUSTED_DELETION_EVIDENCE_REQUIRED.
5. The ledger's RELEASED tombstone prevents double disk-reservation release on repeated calls or connection epochs; the result RELEASED includes both first and repeated releases, and **must never be counted as a fresh refund**. Existing byte admission during the rolling minute is **never refunded** after cancel, reconnect, midnight, or lost ACK.
6. Any missing authority, dishonest witness, deleted-without-writer-fence, grant revoke, UNKNOWN, stale epoch or failed budget ledger update fails closed without a new disk release.

## #640 semantic boundaries

- Cancel before any native write dispatch may finish CANCELLED (not MUTATION_UNKNOWN) with zero admitted bytes. A declared storage reservation still cannot be dropped until trustworthy writer fence plus deletion/confirmed absence are supplied.
- Cancel after actual native write dispatch but before its ACK requires MUTATION_UNKNOWN and a pending byte reservation. No automatic write replay, false success or refund.
- This adapter does not change production #640 behavior. The tests model the two cases in independent disposable SQLite handles and a synthetic external source.

## Acceptance status

| Gate | Result |
| --- | --- |
| Own independent quota source tests | PASS when verified at exact HEAD |
| Existing #610/#625 local source tests | PASS when verified at exact HEAD |
| #616 + #610 assembled source | FAIL CLOSED on missing independent deletion proof |
| Actual #596/#616/#634 native writer and #605 disconnected ACK | NOT TESTED |
| External monotonic CAS/writer-fence physical implementation | NOT TESTED |
| Cloudflare Workers/D1 staging | BLOCKED without authorized staging identity |
| Actual CORE/UAC/elevated shell | NOT TESTED |
| Real billing, invoices, subscriptions and production entitlement | OFF / NO-GO |

Production Free remains **1,000 weighted credits per UTC month**, verified owner exception and special-skill weighting unchanged. Future daily Free 1k, Plus 5k, Pro 10k remain dormant. No unlimited MCP upload envelope introduced.

**This is a contract and test suite, not proof of a real physical deletion or an integrated #08 transfer. Keep DRAFT until trusted writer-stop and deletion evidence is wired and independently tested.**
