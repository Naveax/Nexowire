# Journal-owner PID incarnation integration with CORE #980

**Source-only child Draft. CORE NO-GO.** Based on #980 exact SHA `7e4093c30c1ead3cd22888184450c34aef4737da` and incorporates only #1002's owner-process identity and fail-closed startup evidence from `bce2dbdfca93d3537657c37e15d9248f17106a8a`.

- Preserves #980 independently configured JournalAuthority, rollback mismatch guards, remote CAS-before-journal mutation, CORE console admission, singleton and WAL read-only startup.
- Journal owner table gains a process-identity column only as part of initial mutation setup. A native current PID incarnation and previous stored process snapshot are read before BEGIN IMMEDIATE, then rechecked under that same transaction. Only positive process death/identity mismatch can reclaim; unknown/legacy live owner denied.
- `src/agent/journal-owner-process.ts` is copied byte-for-byte from #1002 and is an OS metadata diagnostic, not task execution authority. Windows process birth readback is mandatory.
- Request cancellation after asynchronous journal.begin and persisted markDispatched prevents late executor entry; existing external reservation is not undone or automatically replayed.
- Preserves #1002's regression suite, Windows packaged runtime verification, launch-sinks source audit and README. Both #980's CAS regressions and #1002's true incarnation/live-owner negatives must be verified in the **combined exact source HEAD**.
- This child does NOT change #980, #1002, #994 or any AI branch; no merge/deploy/real device or CORE enabled. Source green does not imply physical approval.
- Separate #994 workflow conflicts and #990 native add/add conflict remain unaddressed by this child.
