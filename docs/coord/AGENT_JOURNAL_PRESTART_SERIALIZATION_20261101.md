# Agent journal same-process startup preflight serialization (2026-11-01)

**SOURCE-ONLY / HOTFIX REVIEW. CORE production remains NO-GO.**

The already merged source repairs #986 and #1002 passed independent CI,
but fresh combined-main CI [41252418555](https://github.com/Naveax/Nexowire/actions/runs/41252418555)
observed an intermittent **Node 24** failure in the unchanged
`test/agent-journal-owner-incarnation.test.ts` concurrent-startup negative:
one rejected contender got `AGENT_JOURNAL_WAL_CORRUPT` rather than
`AGENT_JOURNAL_IN_USE` while a peer was starting/updating WAL.

This candidate makes `AgentOperationJournal.initialize()` *serialize only
within the same process and normalized journal path*, before it verifies
WAL and opens SQLite. Every contender still verifies the complete WAL;
only the real SQLite BEGIN IMMEDIATE / owner-process incarnation CAS can
admit mutation. A rejected contender must still throw IN_USE and not
create a second lease. Rejected/failed initializations release their
queue slot in `finally`; a later attempt can retry.

The original adversarial test assertions are unchanged. **No blanket
catch of AgentJournalWalError, no retry of mutations, no WAL repair, no
journal delete, no owner-lease bypass or synthetic proof** was added.
Cross-*process* writer/WAL races, path aliasing, kernel identity, signed
installer Windows acceptance and physical two-PC restart/rollback
remain separate pending gates. This is **not** a replacement for
independent OS-process locking or stable SQLite recovery.

Required evidence: exact-head Node 22/24 and Windows concurrent-owner
negative tests; no duplicate initialization owner; no WAL invalid
false-positive during same-process startup; persistent corruption
continues to fail closed. No physical work/deploy by this PR.
