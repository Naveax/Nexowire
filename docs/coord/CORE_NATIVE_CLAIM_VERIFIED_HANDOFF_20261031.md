# Coordinator handoff: durable native-verified CORE claim gate

**Scope:** P0 source-only SQL gate for the independently reproduced early D1 `complete(succeeded)` race. Branch `coord/core-claim-verified-ledger-20261031`, based on CORE #980 exact head `7e4093c30c1ead3cd22888184450c34aef4737da`. This is a **Draft** and must not run against production until reviewed and staged. CORE remains **OFF/NO-GO**.

## Observed regression and ownership

AI-08 #989 (head `6004e2b44c8a5c5f9374a74498e98288e4d8f5cb`, CI 41199793251) demonstrated `{acceptedEarly:true,stateAfterDeniedReadback:'succeeded'}`: D1 writes `reserved -> dispatched` before awaiting a genuine native session readback; a concurrent signed `complete(succeeded)` can be accepted while that readback is still pending. AI-06 #985 independently reproduced the SQL-level interleaving and added a terminal audit fence, but correctly recorded that it does not reject the early completion ACK.

**Coordinator owns:** additive migration `cloudflare/migrations/0021_core_console_native_claim_verified.sql`, isolated SQL tests. **AI-06 owns:** `src/product/d1-core-console-authority.ts` update. No other AI's branch or source files have been modified in this coordinator Draft.

## Migration behavior

- Add `native_claim_verified INTEGER NOT NULL DEFAULT 0 CHECK (native_claim_verified IN (0,1))`. Existing rows remain zero; do not backfill `1` from `state`, signed JSON, synthetic receipt, admin role or old installer status.
- A fresh INSERT cannot seed `native_claim_verified=1`.
- The native verification marker may change from 0 to 1 **only on an already dispatched** operation, never in the same statement that transitions to terminal success.
- A legacy Worker attempting `dispatched -> succeeded/denied` without marker 1 gets an SQL ABORT, even if it possesses a signed application payload.
- `unknown` cannot become a dispatched/succeeded operation again. A denied/uncertain native claim may quarantine `dispatched` or early terminal audit evidence as `unknown`.
- Existing `succeeded` audit rows remain historically recorded but **unverified** by this new marker. They must not be used as fresh native authorization; separate independent evidence/reconciliation is required.

## AI-06 required source integration

Within the existing `claim` winner path and immutable `opArgs`:

1. Reserve and claim with `UPDATE ... SET state='dispatched' ... WHERE state='reserved'` preserving `native_claim_verified=0`.
2. Await independent `currentReadback(nativeBinding)`. Immediately validate current D1 owner/device/platform/ready/native receipt, installation, enrolled session SID/LUID/epoch and revocation generation against the *original immutable request*. Treat any stale/uncertain witness as DENY/UNKNOWN.
3. Only the unique winning claimant performs a second D1 compare-and-swap:

```sql
UPDATE device_core_console_operations
   SET native_claim_verified=1
 WHERE request_id=? AND fingerprint=? AND device_id=?
   AND installation_id=? AND enrollment_id=?
   AND owner_epoch=? AND grant_generation=? AND revoke_epoch=?
   AND state='dispatched' AND native_claim_verified=0
   AND device_id IN (
     SELECT c.device_id
       /* existing owner-credential JOIN and currentPredicate/READY */
   );
```

This second CAS must require **exactly one** changed row and the current native receipt/session identity in the admission predicate. A snapshot alone is not an OS trust witness. If it fails, deny the claim, quarantine only the winning request, and never send a success ACK.

4. `complete` must add `AND native_claim_verified=1` and check the same immutable owner/device/session/epoch/capability payload. The SQL trigger independently blocks old Worker code that lacks this predicate.
5. Preserve terminal UNKNOWN/lost-ACK and duplicate winner/loser handling; do not weaken tests to accommodate this migration. Re-run AI-08's deliberately failing early-ACK adversarial test.
6. A successful marker only proves the D1 claim transition followed a native-verifier return. It is **not** proof that the real OS effect happened, or that the session cannot change after the check. The native effect-boundary admission must still read back current OS/process/desktop and independently consume effect-bound CAS.

## Rollout and acceptance (coordinator only)

- Verify migration on a disposable D1/SQLite schema snapshot with existing old rows and malformed/race inputs. Check that legacy deployed Worker fails closed against the new schema.
- Stage Worker and migration in a coordinated maintenance window with genuine rollback and monotonic grant authority; a rollback to code without the marker must not re-open early success.
- Do not apply D1 migration to production, enable CORE, deploy, merge or touch either authorized computer in this Draft.
- Required source tests: no old-row auto grant, premature complete SQL abort, winner's two-phase CAS, late native deny -> sticky UNKNOWN, forged preverified INSERT denied, no in-place same-statement complete, revoke/session-switch/readiness races, real D1 adapter integration.
- Physical tests additionally require protected client/server PKI, real Windows UAC owner approval, external CAS, native signer/current OS evidence, session switching, revocation, lost ACK and reboots. **No source test or CI result can substitute for this.**
