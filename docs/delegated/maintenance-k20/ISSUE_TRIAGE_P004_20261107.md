# K20 issue lineage and owner-scope audit — 2026-11-07

Scope: T-369 / #539. Source: live `GET /repos/Naveax/Nexowire/issues?state=open&per_page=100&page=N` (all pages, exclude `/pull/` records); source `main` `4e7db16f4233048a956664bef6b607781eb63fb7`.

**22 open GitHub issues** ≠ **22 R01–R22 subtasks** within #539. These are two distinct counts. #539's R checkboxes remain unchecked in the issue text; this audit does not close or authorize any of them. #260 is now **closed** and must not be counted among the 22. Each row below is a real open issue, not a PR.

| Issue | Kind | Severity in title/body | Relation / safe boundary |
| --- | --- | --- | --- |
| #1006 | Standalone gate | P0 | Release and CI approval; owner only |
| #1001 | Standalone defect | P0 | Installed Agent journal owner; CORE |
| #974 | Standalone defect | P0 | Native Agent WAL restart; CORE |
| #812 | Standalone defect | Unspecified | Status/source drift; non-core UI QA only |
| #780 | Product epic | P1 | Coding-agent roadmap umbrella; no sandbox authority |
| #617 | Standalone integration blocker | P0 | Admin Bridge/Hyper-V privilege evidence; CORE |
| #588 | Standalone defect | P1 | Large-file ceiling; offline transfer UX QA only |
| #587 | Standalone vulnerability | P0 | Journal/authority co-rollback; CORE |
| #540 | Subtask | P1 | Child of #539/R07; process tree ownership CORE |
| #539 | Reliability umbrella | Mixed | R01–R22; do not count as independent implementation |
| #487 | Subtask | P0 | #482/S5; cost/capacity offline evidence only |
| #486 | Subtask | P0 | #482/S4; protected billing |
| #485 | Subtask | P0 | #482/S3; onboarding QA/docs only |
| #484 | Subtask | P0 | #482/S2; protected quota/auth |
| #482 | Scale umbrella | P0 | Parent of S2–S5; planned, not production acceptance |
| #481 | Handoff/index | Index | Preserves parked work, explicitly freezes #271 |
| #402 | Standalone defect | P0 | Isolated AI screen input; protected |
| #323 | Standalone feature | P0 | Broker/Admin Bridge lifecycle; protected |
| #322 | Standalone feature | P0 | CORE access grants; protected |
| #271 | Standalone security issue | P0 **ON HOLD** | Owner hold in #481; no ACL remediation authorized |
| #269 | Standalone feature | P4 | Signed Windows bootstrap; non-core guides only |
| #265 | Standalone rollout | P2 | Owner-bound MCP router; protected |

Result: **13 standalone, 5 subtasks, 4 umbrella/index**. "Standalone" means a separate issue requiring its own acceptance; it does **not** mean safe for K20 to implement. Triage scripts fail closed for newly encountered issue numbers. The 22-open-issue inventory is a point-in-time REST result, not a perpetual assertion. K20's `triage-open-issues.mjs` emits a dated-scope lineage on each supplied `/issues` snapshot and excludes PRs/closed issues.

For the assigned #539 slices: R01 (error contract, P0), R11 (reliability doctor UI, P2), R17 (environment doctor, P1), R18 (work-progress watchdog, P0), R22 (source/CI/provider/release gates, P1). In #539 these are *subtasks of one open umbrella*, not five extra open issues. No real-device or release acceptance is inferred.

Evidence boundary: live issue metadata and static source review only; no live Windows device test, provider soak, CI approval or owner PR merge performed. #1096 currently remains Draft and owns `src/agent/process-manager.ts` and CORE-adjacent areas; K20 modifies none of them.
