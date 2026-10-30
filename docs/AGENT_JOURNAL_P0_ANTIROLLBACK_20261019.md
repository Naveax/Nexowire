# P0 Agent Operation Journal: independent reservation authority (2026-10-19)

**Scope:** source-only safety gate atop MERGED #558 and #567, not a replacement
of their journal, WAL verification, Hub reconciliation or idempotency code.
Base at time of branch creation: `origin/main`
`cb819d17ee581093d39626f13e985976def17f30`.
No live Agent/Broker/Hub was restarted or upgraded. At inspection Work PC and
Naveax reported **native Agent v1.0.5**, not the merged v2 code.

## Root cause and corrected sequence

A valid restored SQLite journal snapshot from before a successful operation
can omit its original request ID. The old source accepted the missing
request ID as a new reservation. Checksums, WAL replay and SQLite
`quick_check` cannot distinguish a consistent *older* snapshot.

New `JournalAuthority` is a **separate, pre-provisioned** SQLite WAL/FULL
database with `authority_id`, explicit `generation`, monotonic AUTOINCREMENT
`sequence`, a unique `request_id`, capability and request fingerprint.
It is not put in the journal's backup directory. It has no command text,
token, environment, input payload, stdout, stderr, or tool output.

Native Agent now **requires** the following explicit configuration at startup:
`NEXOWIRE_AGENT_JOURNAL_AUTHORITY_FILE`,
`NEXOWIRE_AGENT_JOURNAL_AUTHORITY_ID` (UUID),
`NEXOWIRE_AGENT_JOURNAL_AUTHORITY_GENERATION` (UUID).
No values are invented/defaulted. There is **NO Agent auto-provision**.
The exported provisioning helper exists for isolated tests and a future
independently authorized operator workflow, not automatic deployment.

Mutating `begin(id, fingerprint, capability)` performs:
1. Verify authority path and live file identity, epoch and journal binding
   against its monotonic head. Missing/unavailable/renamed/wrong epoch fails
   closed. A legacy nonempty unbound journal needs independently verified
   migration instead of automatically enrolling old rows.
2. Atomically reserve the exact ID in **authority first** (`BEGIN IMMEDIATE`
   and `synchronous=FULL`). Duplicate/fingerprint mismatch never earns a new
   reservation. Authority-only orphan => UNKNOWN, not an executable request.
3. Commit journal reservation and its matching `last_sequence` in a single
   journal transaction. If journal storage/write fails after the authority
   commit, journal and authority diverge and all future dispatch fails
   closed until *authorized* recovery. Do **not** silently reconcile or reset
   the authority to match journal.
4. Before `markDispatched` and `complete`, re-check the authority epoch.
   No mutation executor is called if durable proof is missing or disagrees.
   Existing immutable terminal states and CAS still apply.
5. Agent initialization verifies bound identity and monotonic sequence
   **before** recovering in-progress journal entries. Stale journal, WAL
   rollback, copied old DB or wrong generation blocks startup.

The existing `AgentOperationJournal` constructor without authority remains
for legacy *unit fixtures only*. The actual `runNativeAgent` call site
passes the **required** authority configuration; missing configuration
prevents startup, including read-only tools. This is a **breaking release
gate**, deliberately not a silent fallback to old behavior.

## Verified negative test matrix (isolated Windows Work PC)

`test/agent-operation-antirollback.test.ts`:
- Consistent old SQLite snapshot restored after a second completed request:
  stale epoch => `AGENT_AUTHORITY_ROLLBACK_DETECTED`; *same* and *new* IDs denied
- Actual Node child crash after two reservations; original hot WAL recovers
  dispatched request UNKNOWN with replay denied; prior DB+WAL(+SHM) copy
  restored => `AGENT_AUTHORITY_ROLLBACK_DETECTED`
- Same requestId CAS, wrong fingerprint, restart; authority seq unchanged
- Missing authority file, mismatched identity/generation, corrupted authority
  WAL header, incorrectly co-located storage: fail closed
- New/copied unbound journal with nonzero independent authority head: denied
- Authority reservation successful + journal capacity write refused:
  both future dispatch and restart fail closed; no automated repair
- Hub restart and isolated Hub JSON data loss: authority ID still blocks
  previously completed operation
- Existing nonempty legacy journal without verified migration: denied
- Unexpected replacement of open authority file: Windows NTFS itself
  returns EBUSY for the live SQLite handle; path/identity check exists for
  platforms allowing replacement
- Only opaque IDs, SHA-256 fingerprints, capability labels, monotonically
  assigned integers and epoch UUIDs occur in the authority schema

Initial source validation: **107/107** relevant Agent/Hub/MCP/provider and
negative tests PASS, `npm run typecheck`, `npm run build`, and
`npm run continuation:check` PASS in isolated worktree. These are not
production or two-device attestation.

## Unresolved P0 release gates: trust boundary matters

**A second SQLite database on the same restorable disk is NOT sufficient
independent monotonic storage.** If **both** journal and authority are
rolled back together to an old consistent pair, neither SQLite nor epoch
UUIDs stored in those same files can detect it. The code does not pretend
otherwise. For production the authority must be deployed under an
**independently protected, non-co-restorable trust/retention domain** such
as a separately owned append-only durable service or appropriately
attested hardware monotonic store. The provided SQLite adapter is a
reference/test adapter for journal-only rollback, and can be deployed only
after independent protection of its lifetime and physical write/restore
policies has been verified. Same-volume folders alone are insufficient.

**Mandatory additional acceptance**:
1. Build a trusted authority provisioning and owner attestation mechanism
   with immutable device/generation binding outside the journal restore
   domain; verify ACLs, TPM/remote authority or equivalent monotonic
   assurance, signed hashes, continuous retention, audit and backup.
2. Define a conservative **legacy migration**: old live journal and Hub
   unresolved IDs must be enumerated and reconciled under physical owner
   authorization, then sealed to the independent authority. Do not
   re-provision unknown history. Abort if exhaustive evidence is absent.
3. Test true two-domain rollback: restore journal *and* authority backup
   separately, rotate/replace identities, lose network/power during both
   commits, and verify there is **no** path to re-execute a historical ID.
4. Use isolated Windows Agent/VM and isolated bounded disk/VHD for physical
   SQLITE_FULL, WAL torn write, journal/authority ACL, service identity,
   real backup/restore and installer rollback tests. No shared C: fill.
5. Test independent Hub/authenticated offline status, owner revocation,
   wrong device, reconnect storm and two upgraded physical Agents. Hub
   status or absent Agent row is not proof of no side effect.
6. Exact-head CI, independent security review, signed package provenance,
   canary rollback that preserves tombstones, then production signoff.
   **Do not deploy this source to live Agent 1.0.5 automatically.**

### Recovery invariant

`MUTATION_STATE_UNKNOWN`, `AGENT_AUTHORITY_ROLLBACK_DETECTED` or missing
authority evidence means **no replay**. Preserve journal, WAL, SHM and
authority evidence; reconcile the original requestId against trusted
external postconditions. Operator-authorized resolution is required;
never delete a tombstone, silently reset the epoch, or issue a fresh
requestId to hide an ambiguous mutation.
