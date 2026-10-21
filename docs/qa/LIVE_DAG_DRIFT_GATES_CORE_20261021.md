# NEXOWIRE P0 Worker #24: Live integration DAG drift / SHA provenance

Date: **2026-10-21**, repository `Naveax/Nexowire`. This QA update is **SOURCE-ONLY, DRAFT, PRODUCTION NO-GO**. It neither merges PRs nor reruns CI. It never installs/starts Agents, elevated Brokers, UAC, services or VMs. `ReVoltVPN-Ubuntu-Lab` remains excluded.

## Verified GitHub state (read-only)

- `main` HEAD at observation: `754cc4364822be5fda528f54042fb22a84f19924`.
- #630: `merged:true`, closed; not counted among open PRs.
- Original #646: `65b96fa17b7050685e24dd6a0851da0d80131975`, exact-head CI **failure** on [run 39627296601](https://github.com/Naveax/Nexowire/actions/runs/39627296601). Node22/24, Linux, WSL2, security, hosted Windows `browser-live` all completed successfully; macOS job was **cancelled**, so the aggregate is not PASS. No new run or rerun was requested.
- Initial 50 open PRs grew to **67 open PRs** during the same review. [Latest frozen 67-PR snapshot](./p0-integration-dag-open67-20261021.json) records **41 parent-child edges**; its sampled primary CI outcomes were **31 successful, 24 failed, 12 queued/in_progress**. The earlier [50-PR snapshot](./p0-integration-dag-open50-20261021.json) is deliberately retained as drift evidence, not current truth. Exact CI run IDs correspond to the queried PR HEAD; no release-readiness or specialized QA workflow is substituted for primary CI.
- Current parent SHA mismatches: **#609 on #576** and **#622 on #618**. The 29 newly observed PRs #638-#666 were independently compared against recorded base SHA, each reporting `ahead`; this **does not** waive CI, incomplete old-path coverage, or inherited parent hazards. #643 progressed from in_progress to success on the same SHA, which is also a snapshot-drift event.
- Known independent Windows Job ownership collision: #576, #629, #633 all edit `.github/workflows/ci.yml`, `native/windows-job-owner.c`, `src/agent/process-manager.ts` and `src/agent/windows-job-owner.ts`. A changed-path overlap is a **review blocker**, not a proven Git merge conflict.
- Separate source QA #638 may pass its own specialized hosted Windows workflow while primary CI fails. A primary CI failure dominates. #643 was still pending during this capture; no approval is inferred.

## How to get truly fresh current GitHub data

The committed 50-PR and 67-PR JSON files are **dated frozen evidence snapshots**. It is *not* auto-updated by GitHub and can go stale instantly. The independent read-only refresh tool retrieves **all** open PR pages from GitHub REST, each current SHA and parent base, every changed-files page, the HEAD-specific `CI` workflow, and the real exact `compare/{baseSHA}...{headSHA}` merge base. It then re-reads the open PR set and `main` to reject a torn snapshot if branches move while auditing.

```bash
# Run only in a checked-out copy of the exact QA branch with Node >=22.
# Read-only repo permission is sufficient. Do not print or commit your access token.
export GH_TOKEN='<read-only ephemeral GitHub token>'
node --import tsx scripts/qa24-live-dag.ts \
  --repo Naveax/Nexowire docs/qa/p0-integration-dag-20261021.json \
  > qa24-live-audit.json
# Exit 2 means findings/blockers; exit 3 means GitHub API/permissions/race FAILED CLOSED.
# A 0 exit is never production authorization: the output's gate remains NO_GO.
```

The token is sourced only from `GH_TOKEN` or `GITHUB_TOKEN`, is never included in output or error messages, and must not be committed. **No unauthenticated live refresh was executed. The GitHub connector was used to independently pin the observed 67-head state; the on-demand full scanner still requires an authorized read-only token.** A missing token, unreadable repository, API pagination overflow, HTTP errors, malformed PR/commit metadata, or mid-collection PR movement fails closed; the CLI does not silently reuse a previous green run.

### Deterministic tests

```bash
npm ci
node --test --import tsx test/qa-24-live-dag.test.ts
npm run typecheck
```

The hermetic fixture suite verifies old→new open-set discovery, HEAD rebases, CI lifecycle drift on the same SHA, forged cached green on a different SHA, mismatched workflow/event, incomplete run pagination, stale or red parent, owner-collision vs actual ancestry, unknown parent, incomplete files, unknown merge base, credential absence, API failure and PR-list changes during collection. It uses no real GitHub token and performs no network requests.

## Enforced interpretation

1. `SUCCESS` requires a completed `CI` run **at the same exact HEAD SHA**, not a prior parent run, specialized test job, green child of red parent, or successful Release Readiness job.
2. A moved HEAD, new open PR, changed main, changed base or CI lifecycle, missing/closed PR, partial file/CI evidence, or inconsistent double-read returns a finding or fails closed. Unknown stays **BLOCKED**.
3. PR stack parent is derived by exact `base.ref` ↔ currently open PR `head.ref`, with the GitHub base SHA compared against the **current parent HEAD**. Unresolved parent or `main` divergence cannot be silently treated as safe.
4. Each independent PR pair modifying the same file requires owner review. Ancestor-descendant overlaps are normal stacking, not independently owned collisions.
5. Physical installed signed Broker, protected Windows ACL/updater/import paths, real elevated token/process identity, one legitimate local UAC enrollment, durable external CAS and actual postconditions remain independent **PHYSICAL BLOCKED** evidence gates.

## Shortest safe route to real CORE (for #00 integrator)

Resolve stale bases #609/#622 and broken parent CI before interpreting child green. #04 owns #574→#621 durable owner/ROOT/CORE grant truth; #01 owns #582→#607→#614→#631 independently deployed CAS and revocation; #12 owns #551→#632 signed installer/rollback/bootstrap; #03 owns #620→#633 elevated Broker contract and #576 Windows Job signed executable reconciliation, with #629/#638 QA reviewed rather than pasted into different owners. Then require separate trusted Windows physical high-token, ACL/AuthentiCode, UAC, owner epoch/revoke/re-pair, durable CORE and 15m ROOT readback. No broad P0 merge until the integrator verifies fresh heads/CI and a conflict-free, exact SHA merge rehearsal.

The Artifact #596→#616→#634 chain, with #640/#641 new independent QA, remains separately **red/blocked** and must not be merged to accelerate CORE. #00 owns release decisions; #24 owns only this evidence-gathering and test code.
\n**Snapshot self-reference:** #664 appears as a node in the 67-PR file at the SHA observed *before that file was committed*. Writing the evidence necessarily advances #664 HEAD, so that recorded head must immediately be considered stale. This is the intended fail-closed behavior, not a green CI claim.\n