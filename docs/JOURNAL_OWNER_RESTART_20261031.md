# Journal owner refusal on Agent 1.0.8

The owner supplied a real startup failure from installed 1.0.8:
`AgentOperationJournalError: Another journal owner may be executing mutations.`
This is AGENT_JOURNAL_IN_USE, distinct from #974's earlier WAL checksum/reuse
failure. No live DB, owner PID or process creation time has been collected, so
PID reuse in this particular installation is not yet proved.

The released owner guard stores only pid/nonce and calls process.kill(pid,0).
A surviving PID is not proof that it belongs to the previous journal writer:
Windows can reuse it after crash/reboot. The v1.0.8 Agent also initializes the
mutation journal before connecting, turning even an appropriate write lock
refusal into total loss of diagnostic connectivity.

The correction stores an OS process-incarnation identity on new owner leases:
Windows creation FILETIME from a QUERY_LIMITED_INFORMATION process handle;
Linux boot ID plus /proc start ticks when /proc and process PID namespaces match.
Only positive death or positive same-platform incarnation mismatch permits a
claim. Live matching owners, legacy live PIDs without birth evidence, access
denials, malformed records and changed owner rows remain blocked. The owner
pid/nonce/incarnation snapshot is compared again under BEGIN IMMEDIATE after
asynchronous process readback. Unsupported/ambiguous OS evidence retains the
old conservative liveness fallback rather than guessing identity.

Read-only Agent startup validates WAL without claiming mutation ownership.
Every mutation still must complete begin() and markDispatched() before executor
entry. Contention becomes an error response instead of Agent fatal exit. This
does not authorize a write under an unknown legacy owner, disable journal
guards, or replace any WAL/DB/SHM. Existing tombstones and IDs remain unchanged;
only proven abandoned in_progress entries become UNKNOWN as before.

Baseline reproduction: real released-main a19a228 CLI, disposable journal held
by a live writer and a disposable WebSocket Hub: exits1 before hello. Fixed CLI:
connects, returns AGENT_JOURNAL_IN_USE for files.write, creates no target file and
stays alive. Existing authentic SQLite 709-current/295-retained-frame and 1307
operation restart tests remain unchanged. The PID-reuse test seeds a historical
incarnation then checks real current OS identity; it does not claim to force
physical Windows PID recycling. Windows CI must supply actual incarnation
readback and cannot skip this acceptance case. Local sandbox has host /proc PID
numbers differing from its process namespace, so its identity case is explicitly
skipped and conservative liveness behavior is exercised instead.

No live installation or physical reboot acceptance is claimed. A legacy live
PID row is deliberately not erased based on chat approval or PID number alone;
recovering that particular installation still needs independent owner-process
evidence or confirmed original process exit. This patch allows diagnosis to stay
available while preserving that boundary. The observed Funnel/connector host
name mismatch is a separate connectivity problem, not this stack trace's cause.
