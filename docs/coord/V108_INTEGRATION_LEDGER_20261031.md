# Nexowire v1.0.8 | Coordinator integration ledger

Status: **SOURCE INTEGRATION IN PROGRESS / CORE PRODUCTION NO-GO**.
Owner: coordinator only. Snapshot basis: GitHub main `a19a228dc6f19fd484cf935e941a00ea625233f8` (2026-10-31).
This file describes review gates. It does **not** authorize merge, installation, elevation, enrollment, reboot, payment or production deploy.

## Objective and two-week target

By 2026-11-14, seek a reviewable v1.0.8 candidate that survives valid SQLite WAL reuse and Windows restarts, can be reverted without journal/token loss, and is ready for opt-in physical two-PC acceptance. CORE remains OFF unless independent protected authority, native OS evidence, revocation and effect-boundary gates are genuinely passed. A branch, synthetic test or CI success is never equivalent to physical authorization.

| Scope | Rough time from 2026-10-31 | Confidence/constraint |
| --- | --- | --- |
| Restart-safe v1.0.8 source candidate | 7–14 days | Conditional on WAL fix + regression |
| Integrated CORE development/beta candidate | 3–6 weeks | Multiple OS, trust and database dependencies |
| Physically accepted, reliable release | 6–12+ weeks | Real Windows, credential, rollback and soak required |

These are planning ranges, not promises or measured completion percentages. Eight AI agents plus the owner's friend increase parallel throughput, but integration/security gates are sequential bottlenecks.

## Ownership and no-conflict integration

- AI-01 #986: `src/agent/operation-journal-wal.ts`, dedicated WAL tests. Coordinator alone owns `src/agent/operation-journal.ts`, Agent entry/startup and protected file-handle/namespace integration.
- AI-02 #993 (base #984): `native/windows-local-enrollment/**`, `scripts/local-enrollment/**`, v2 enrollment protocol/tests. Coordinator owns Agent integration and physical deployment.
- AI-03 #988 (base #982): mTLS verifier client and negative tests. Coordinator owns protected PKI/pin provisioning and server-to-Agent composition.
- AI-04 #987 (base #980): Broker admission/Windows native Job handle ownership. Coordinator owns shared launcher wiring and independently trusted receipt authority.
- AI-05 #992 (base #980): immutable CAS and admission reservations. Coordinator owns shared executor/Agent composition.
- AI-06 #985 (base #980): CORE console claims. Coordinator owns effect-boundary and protected session readback integration.
- AI-07 #990 (independent sandbox-contract base): OS worker isolation and negative tests. Coordinator owns shared runtime dispatch. A source capability flag is **not** a sandbox proof.
- AI-08 #989 (base #984): adversarial QA only. Test fixtures never produce native authorization.
- Friend: strictly separate low-risk UI/docs/offline tools. No CORE authority, CI, release, shared protected paths.

## Required dependency edges

`main -> #980 -> #981 -> #982 -> #983 -> #984`

- #993 depends on #984.
- #988 depends on #982.
- #989 depends on #984.
- #987/#992/#985 depend on #980.
- #986 depends on main and is a separate WAL lane.
- #990 depends on the existing sandbox contract base, not a CORE parent.

Check the **current head SHA and base head SHA** for each edge, every time. A green CI run for an earlier SHA is irrelevant. Draft PRs cannot be silently promoted to production; human review and authorized merge are separate decisions.

## Independent WAL/journal handoff (P0 #974)

1. Fix valid RESTART/recycled WAL classification without clearing records or silently checkpointing user DB/WAL/SHM. Preserve original UNKNOWN, request fingerprints, terminal tombstones and replay denial.
2. `src/agent/operation-journal.ts` currently awaits a WAL preflight and then opens SQLite. The entire DB/WAL/SHM namespace may change between verification and checked-open. Re-stat alone narrows the gap but does **not** make the transition atomic. The coordinator must propose a real Windows singleton/protected namespace or native checked-open handoff and test swap/truncate/recycle races.
3. Protect against another process replacing an opened DB, WAL or SHM path; bind verified identity to what SQLite really opens. A benign recycled WAL must succeed on normal restart. An uncertain or adversarial path change must fail closed without modifying original evidence.
4. External CAS/monotonic witness remains mandatory wherever replay/rollback resistance is claimed. A SQLite lock or a hash of a test fixture does not constitute independent authority.
5. Acceptance: exact SHA CI, restart/recycle loops, corrupt/torn-WAL denial, safe backup/rollback evidence, **real** Windows 10/11 owner-approved device validation. Do not close #974 or assert installed 1.0.8 without an installed fixed build and restart evidence.

## CORE integration contract (NO-GO until physically proven)

Before an effect, verify *the same immutable request identity and exact payload* across:
- authenticated owner identity; stable device ID, installation ID and generation;
- locally witnessed SID, logon LUID, session ID/epoch and real console state;
- independently signed/revocable enrollment grant with non-exportable key custody;
- current monotonic revoke/restore state and one-use atomic external CAS;
- Broker native token, signer/runtime and independently verified OS Job/sandbox;
- effect-boundary fresh readback, identical capability/fingerprint and signed receipt;
- lost ACK/UNKNOWN replay tombstone that survives restart and reconnect.

Any missing or untrusted witness means DENY/UNKNOWN, not permissive fallback. `localEnrolled` and `CORE.active` must never be set from fixtures or client JSON. No automatic UAC/Secure Desktop bypass, and no physical input without real on-device authority.

## S0/S1 coordinator checkpoints

- [x] Inventory eight AI Draft PR numbers, their parent branch dependencies and file ownership.
- [x] Create a dedicated read-only exact-head CI / branch dependency audit with negative tests: `scripts/qa-v108-integration-gates.mjs` and `test/qa-v108-integration-gates.test.ts`.
- [ ] Obtain exact HEAD full CI for each agent and each parent; retain run ID, 7/7 (or explicit native extra jobs), branch and commit. Do not dispatch duplicate workflow runs.
- [ ] Finish `operation-journal.ts` atomic checked-open design, then implement under coordinator-only ownership with adversarial tests.
- [ ] Verify P0 #974's actual fixed-source regression and legitimate WAL reuse against v1.0.8 candidate; only installed physical tests can close incident.
- [ ] Negotiate protected native enrollment IPC/export contract with AI-02 and verifier grant bridge with AI-03.
- [ ] Wire independent effect-boundary admission with AI-04/05/06/07 only when authentic OS/native proof exists.
- [ ] Prepare signed installer, rollback and isolated clean-VM tests; retain functioning v1.0.7 rollback and both existing agents.
- [ ] Perform owner-approved two-PC restart/logoff/revoke acceptance; do not restart live systems as a planning step.
- [ ] Perform final source/staging/release decision. Production remains NO-GO absent completed evidence.

## Read-only audit usage

```sh
node scripts/qa-v108-integration-gates.mjs
```

Optional `GITHUB_TOKEN` is used only for read-only GitHub API requests; it must never be printed or committed. A unit-test fixture is **not** authenticated source evidence:

```sh
node scripts/qa-v108-integration-gates.mjs --fixture disposable-snapshot.json
```

The script reads GitHub PRs, exact-SHA CI runs and jobs; never triggers CI, modifies branches, merges or deploys. Exit code `2` means missing/pending/stale/failed evidence. Exit code `0` means only the *source CI matrix* is internally complete and still requires independent review. In both cases, CORE production is `NO_GO` and physical acceptance is `NOT_PROVEN`.

## Operational boundaries

- Existing owner devices: do not reboot, re-enroll, restart Agent/Broker/Hub, rewrite ACL, reset token, delete journal or enable CORE.
- Keep `NEXOWIRE_PAID_BILLING_ENABLED` paused and existing Free-only hosted quota policy unchanged.
- No direct edits to agents' active PR branches or shared root files without separate ownership coordination.
- Do not combine all source PRs in one blind merge. Preserve their Git history and verified rollback sources.
