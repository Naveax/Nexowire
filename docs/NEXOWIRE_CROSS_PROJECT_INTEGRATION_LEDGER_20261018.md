# Nexowire Central PR Integration and Release Ledger
**Snapshot:** 2026-10-18. **Repository:** `Naveax/Nexowire`. **Integration authority:** this main-integration chat only. **Main at creation:** `a54cbbdd37e981a169631d688b53c7e3b3e90f48`.

> This is a point-in-time operational record, not a claim that CI or deployment gates will remain green. Live GitHub PR/check details are authoritative; re-read them immediately before any merge. No production system was deployed.

## Known pull requests, exact heads, ownership, and release gates

| PR | Owner / integration | Branch | Original base SHA | Verified / current PR HEAD SHA | Files | Dependency and ordering | Tests and CI evidence | Source tested | Staging accepted | Production deployed | Incident closed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [#538](https://github.com/Naveax/Nexowire/pull/538) | Naveax / main integrator | `fix/p0-agent-operation-ledger-20261018` | `9c2334708bafb2ab37f32b198c1da309cf84bb82` | `c99e3a892d68e4221f86669abe637a925dd6c90b` | 15: Agent journal, native-agent, MCP, audit, authorization, tests, docs | Base dependency for R01-R03; merge `9bbe0dc0e1fb05aceb772fb3e7a4cb8678c7f27f` | PR reports 193/193 Work PC tests and separate 24/24; merged | Yes, source only | No | No | No |
| [#542](https://github.com/Naveax/Nexowire/pull/542) | Naveax / main integrator | `fix/p0-shell-task-outcome-20261018` | `9bbe0dc0e1fb05aceb772fb3e7a4cb8678c7f27f` | `1b51a82684918b8f2a148bd48caaa50ee1710274` | 4: `src/protocol/result.ts`, `src/providers/agent-provider.ts`, tests, docs | After #538; merge `8bf7ce10972e78268e3cac945e833781b8d6846c` | PR reports 204/204 focused; integrator retest shell outcomes 8/8 | Yes, source only | No | No | No |
| [#543](https://github.com/Naveax/Nexowire/pull/543) | Naveax / main integrator | `fix/p1-process-tree-cleanup-20261018` | `8bf7ce10972e78268e3cac945e833781b8d6846c` | `243b55b4d8ac03c13bb350fbee6194c6fdac6b34` | 3: `src/agent/process-manager.ts`, scoped Windows tests, evidence doc | After #542; merge `a54cbbdd37e981a169631d688b53c7e3b3e90f48`; #541 orphan ownership remains open | Exact-head CI run `39117489971`: 7/7 PASS. Independent Work PC: 2/2 Windows tree tests; 8/8 shell outcomes, typecheck/build/check PASS | Yes | No, source-only physical test | No | No, #541 remains open |
| [#537](https://github.com/Naveax/Nexowire/pull/537) | Naveax / main integrator | `test/scale-v2-s2-public-wss-revocation-reader-20261018` | `9c2334708bafb2ab37f32b198c1da309cf84bb82` | `5ad37c42873d816782da3d2a218bd200a67e09c8` (synced to main `a54cbbdd`) | 6: `docs/SCALE_V2_EXECUTION_LEDGER.md`, S2 acceptance doc, owner reader, 2 WSS fixtures, revocation test | Can follow #543; high overlap risk on shared Scale v2 ledger with future PRs | New exact-head CI run `39133887722` **in progress at snapshot**, do not retrigger; prior head 7/7. Work PC updated branch: 5/5 revocation tests and typecheck/build PASS | Yes, provisional until exact-head CI | Partial synthetic two-PC proof only; not full staging release acceptance | No | No |
| [#480](https://github.com/Naveax/Nexowire/pull/480) | Naveax / main integrator | `fix/ai-screen-direct-bridge-broker-guard-20261014` | `7d39b8d0d1228fb1460dc3892e4d46e294749ab7` | `ec3c54d77e3b9fabb4c85831222fb48b112cd7b2` (synced to main `a54cbbdd`) | 4: `docs/ai-screen-displays.md`, `src/agent/windows-private-desktop.ts`, `src/agent/windows-private-shell-broker-guard.ts`, parity test | Can follow #543; future GUI/private-desktop changes require overlap check; #402 remains open | New exact-head CI run `39134168129` **in progress at snapshot**, do not retrigger; prior head 7/7. Work PC updated branch: 4/4 physical GUI tests and typecheck/build PASS | Yes, provisional until exact-head CI | No independent-session/VM staging acceptance | No | No |

**Clarification:** “Source tested” does not imply an installed production Agent version was changed. All five known PRs are source-only. For #537, public Quick Tunnel fixture success (signed reserve/replay-deny) is not production SaaS authentication or authority. For #480, static executable denial is not transitive GUI containment. For #543, taskkill acceptance is not proof that every descendant died.

## Incoming development PR inbox (16 expected; no fabricated metadata)

Only three open PRs (#537, #480, at the time #543 before its merge) were returned by GitHub when this ledger was initialized. The following slots deliberately remain unfilled until each other development chat supplies an actual PR URL/number and accountable owner. These are **intake slots, not 16 existing PRs**.

| Intake slot | Development conversation | Owner | PR / branch | Base SHA | HEAD SHA | Files | Dependencies | Tests / CI | Release |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D01 | Assigned AI conversation 1 (unverified) | Unassigned | Not reported | Unknown | Unknown | Unknown | Unknown | Not checked | No PR; no merge |
| D02 | Assigned AI conversation 2 (unverified) | Unassigned | Not reported | Unknown | Unknown | Unknown | Unknown | Not checked | No PR; no merge |
| D03 | Assigned AI conversation 3 (unverified) | Unassigned | Not reported | Unknown | Unknown | Unknown | Unknown | Not checked | No PR; no merge |
| D04 | Assigned AI conversation 4 (unverified) | Unassigned | Not reported | Unknown | Unknown | Unknown | Unknown | Not checked | No PR; no merge |
| D05 | Assigned AI conversation 5 (unverified) | Unassigned | Not reported | Unknown | Unknown | Unknown | Unknown | Not checked | No PR; no merge |
| D06 | Assigned AI conversation 6 (unverified) | Unassigned | Not reported | Unknown | Unknown | Unknown | Unknown | Not checked | No PR; no merge |
| D07 | Assigned AI conversation 7 (unverified) | Unassigned | Not reported | Unknown | Unknown | Unknown | Unknown | Not checked | No PR; no merge |
| D08 | Assigned AI conversation 8 (unverified) | Unassigned | Not reported | Unknown | Unknown | Unknown | Unknown | Not checked | No PR; no merge |
| D09 | Assigned AI conversation 9 (unverified) | Unassigned | Not reported | Unknown | Unknown | Unknown | Unknown | Not checked | No PR; no merge |
| D10 | Assigned AI conversation 10 (unverified) | Unassigned | Not reported | Unknown | Unknown | Unknown | Unknown | Not checked | No PR; no merge |
| D11 | Assigned AI conversation 11 (unverified) | Unassigned | Not reported | Unknown | Unknown | Unknown | Unknown | Not checked | No PR; no merge |
| D12 | Assigned AI conversation 12 (unverified) | Unassigned | Not reported | Unknown | Unknown | Unknown | Unknown | Not checked | No PR; no merge |
| D13 | Assigned AI conversation 13 (unverified) | Unassigned | Not reported | Unknown | Unknown | Unknown | Unknown | Not checked | No PR; no merge |
| D14 | Assigned AI conversation 14 (unverified) | Unassigned | Not reported | Unknown | Unknown | Unknown | Unknown | Not checked | No PR; no merge |
| D15 | Assigned AI conversation 15 (unverified) | Unassigned | Not reported | Unknown | Unknown | Unknown | Unknown | Not checked | No PR; no merge |
| D16 | Assigned AI conversation 16 (unverified) | Unassigned | Not reported | Unknown | Unknown | Unknown | Unknown | Not checked | No PR; no merge |

**Required intake record:** exact PR URL, responsible developer, branch/ref, base + exact head SHA, all changed files, component and workstream ID(s), dependency predecessor, SHA-bound test evidence, current GitHub run ID and 7 check conclusions, review threads, blocking incidents, rollback plan if production is ever proposed, and the four separate acceptance states.

## File conflict and merge precedence

1. #538 -> #542 -> #543: already merged in that order. #543 owns `src/agent/process-manager.ts` and does **not** complete #541.
2. #537: head was updated by a non-force merge of verified main into its PR branch, preserving all 6 original PR files; Git `merge-tree --write-tree` with complete history yielded no conflicts. Re-evaluate after any newer main merge. Potential overlap: Scale v2 execution ledger, owner-quota and OAuth authority.
3. #480: head was updated by a non-force merge of verified main into its PR branch, preserving all 4 original PR files; complete-history Git `merge-tree` had no conflicts. Potential overlap: Windows private desktop, broker guard, AI Screen launch review.
4. #537 and #480 current four/six-file deltas have **no common changed paths** with each other or #543. Future PRs must be compared against main and every active queued PR by path and symbol, not only by GitHub mergeable flag.
5. Developers keep isolated working directories/branches. Only this integration chat updates `main`. Do not modify another developer checkout. Never force-push a developer branch; reject changed expected remote heads. A new merge commit changes exact-head CI provenance.
6. CI **queued / in_progress**: follow existing run ID, do not duplicate workflows for the same SHA/workflow/input. CI all green does not equal staging or deployment approval. Do not turn drafts into release approvals until security/review checks are appropriate.

## Four explicit acceptance fields (per PR and per incident)

- **Source tested:** exact-head syntax, typecheck, build, scoped regression and CI evidence.
- **Staging accepted:** representative connected scenario, independent pre/post-condition verification, environmental identity, failure/rollback drill.
- **Production deployed:** separately approved deployment and reversible verified rollback, installed runtime/version/commit evidence.
- **Incident closed:** original failure scenario reproduced, fix retested on original target and acknowledged, or externally blocked with evidence and documented disposition.

## 22-workstream coverage and unresolved boundaries

Authoritative workstream registry: [`docs/NEXOWIRE_CROSS_PROJECT_RELIABILITY_BACKLOG_20261018.md`](NEXOWIRE_CROSS_PROJECT_RELIABILITY_BACKLOG_20261018.md) with R01 through R22. Not all 22 are complete; core observed cases map to R01/R02/R03 mutation honesty/reconciliation, R04 authorization, R05 USB grants, R06 connectivity, R07/#541 tree ownership, R08 shell outcome, R09/#402 GUI bridge, R10 cross-device SHA, R11 progress UI, R12 Scale v2, R13 provider policy, R14 OAuth, R15 cross-chat continuity, R16 Windows picker, R17 environment drivers, R18 watchdog, R19 lifecycle, R20 atomic append, R21 hardware proof, R22 release gates. App-specific LG bootloader, Windows partitioning, Roblox logic, hardware tests, trading algorithms, vendor policies and Windows UAC are not necessarily Nexowire defects; preserve separate issue scope. Exhaustiveness across all previous chats requires original incident IDs/evidence, not the count “22” alone.

**Production controls:** No live Agent, Hub or Broker modification; no real user quota, billing, DNS or firewall change; no provider/Windows security bypass. Stop release immediately on unknown mutation state, missing exact-head CI, unresolved security review or absent rollback evidence.
