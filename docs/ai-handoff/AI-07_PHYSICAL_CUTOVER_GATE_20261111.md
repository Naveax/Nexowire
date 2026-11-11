# AI-07 physical SYSTEM cutover acceptance: provisional gate

Base: `adccb7c75ead6022d4b79d154849e6f1eeecf44b`, integration PR #1160, critical issue #1161.

## Independent physical observations (2026-11-11)

- Work-PC is reachable, but current operator token is **not elevated** and is **not SYSTEM**.
- Visible running Hub and Privileged Broker tasks use the interactive user principal.
- C: reported **3.06 GiB free** before creating this isolated worktree. The migration code requires **4 GiB reserve plus two state copies** and rechecks free space at receipt time.
- No physical SYSTEM principal, DPAPI acceptance, restart, reboot or rollback acceptance was demonstrated.

**Physical cutover = BLOCKED.** Do not perform any live task, boot, writer, credential or ACL mutation from this branch.

## Source safeguard introduced here

The controlled cutover previously wrote `journal.phase=COMPLETE` and disabled its independent recovery task as soon as the new process returned SYSTEM identity and HTTP 200. Those observations do not verify protected SQLite and WAL state, user-to-SYSTEM DPAPI credential equivalence, CORE revocation, Broker effect authority or reboot resilience.

The post-health state is now `AWAITING_PHYSICAL_ACCEPTANCE`, recovery remains armed, and the caller explicitly returns `pendingPhysicalAcceptance:true` and `physicalRebootAccepted:false`. An automatic recovery task still follows its configured schedule and remains fail-closed on unseen SYSTEM writes. This is **not** a new physical finalization or production READY command.

## Physical operator go/no-go checklist

1. AI-01 supplies exact old SYSTEM task identity, protected task XML backup, successful isolated restore rehearsal and a written stop-mutation handoff.
2. A trusted elevated token is verified by Windows; no UAC bypass. Package and exact current HEAD CI pass.
3. The preflight disk budget passes for the actual C: volume and all recovery backup bytes. If not, stop. Never delete production evidence to make space.
4. Export immutable before-state evidence: legacy task definition, runtime hash, PID/port, SQLite quick_check, record count/hash, WAL state, workspace, audit, credentials metadata (no secrets), protected recovery path and task marker.
5. Arm and verify independent recovery before stopping the legacy writer. No second writer or unknown listener.
6. Snapshot after quiescence, copy offline into a protected ProgramData root and verify both tree digests and bound state receipt. Abort on source drift or ACL/reparse uncertainty.
7. Validate real NT AUTHORITY\\SYSTEM SID, process/token ownership, installed task identity, port ownership, HTTP 200, exclusive SQLite writer, current database integrity and credential HMAC under SYSTEM.
8. Verify CORE revoked/STOP markers remain unchanged, and Broker effect admission through a permitted non-destructive effect and authoritative readback.
9. Exercise controlled restart and real rollback with no new SYSTEM writes; for divergent writes, **preserve SYSTEM state** and fail closed instead of discarding them.
10. Arrange controlled reboot **only after** rollback has independent physical proof. Do not finalize or remove rollback task, journal, user launcher or backup until all physical acceptance criteria are evidenced.

## Evidence taxonomy

- Unit tests and Windows PowerShell mocked failure injection are **synthetic PASS**, not physical PASS.
- Physical test rows stay BLOCKED or NOT_RUN until exact-session evidence exists.
- Draft PR #1160 and issue #1161 remain open and production remains NO-GO.
