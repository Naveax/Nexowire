# Nexowire 1.0.8 | Offline merge-tree rehearsal

**Status: NON-DESTRUCTIVE SOURCE SIMULATION. NEVER A MERGE OR RELEASE PERMIT.**

This coordinator-owned tool checks whether the current **17-PR dependency DAG**
can be combined in the intended order without ordinary three-way Git tree conflicts.
It is deliberately separate from the exact-SHA CI and physical acceptance gates in
coordinator PR #994.

## Files

- `scripts/coord-v108-snapshot.mjs`: reads GitHub main and PR metadata; rechecks the same refs for movement; writes JSON to stdout. No GitHub mutation or secrets output.
- `scripts/coord-v108-merge-tree.mjs`: opens a **separate temporary local clone** and runs `git merge-tree --write-tree`; virtual `git commit-tree` objects exist only inside that disposable clone. Original repository and branches remain unchanged.
- `test/coord/coord-v108-merge-tree.test.ts`: creates disposable synthetic Git histories; asserts clean/no-merge, hard conflicts, stale base and absent SHA denial. These tests are not physical Windows/CORE evidence.

## Use on a separate inspection checkout

Requirement: Git 2.38+ with `git merge-tree --write-tree` support, Node 22+.

1. Capture an API snapshot. `GITHUB_TOKEN` is optional, read-only; never include it in logs or a committed manifest.

   ```bash
   node scripts/coord-v108-snapshot.mjs > /tmp/v108-pr-snapshot.json
   ```

2. Create an independent *disposable* source clone; do not modify the worktrees used by any AI.

   ```bash
   git clone --no-checkout https://github.com/Naveax/Nexowire.git /tmp/v108-dryrun-source
   for id in 980 1005 981 982 988 983 984 993 989 987 992 985 996 1007 990 1004; do
     git -C /tmp/v108-dryrun-source fetch --no-tags origin "pull/$id/head:refs/remotes/origin/coord-pr-$id"
   done
   ```

3. Simulate in a *second, internal* temporary clone.

   ```bash
   node scripts/coord-v108-merge-tree.mjs \
     --repo /tmp/v108-dryrun-source \
     --snapshot /tmp/v108-pr-snapshot.json
   ```

PowerShell equivalent for fetching branches in a disposable clone:

```powershell
$source = Join-Path $env:TEMP "v108-dryrun-source"
git clone --no-checkout https://github.com/Naveax/Nexowire.git $source
980,1005,981,982,988,983,984,993,989,987,992,985,996,1007,990,1004 | ForEach-Object {
  git -C $source fetch --no-tags origin "pull/$_/head:refs/remotes/origin/coord-pr-$_"
  if ($LASTEXITCODE -ne 0) { throw "PR fetch $_ failed." }
}
node scripts/coord-v108-snapshot.mjs > (Join-Path $env:TEMP "v108-pr-snapshot.json")
node scripts/coord-v108-merge-tree.mjs --repo $source --snapshot (Join-Path $env:TEMP "v108-pr-snapshot.json")
```

## Gates and interpretation

The manifest requires exact main commit, all 13 expected PRs, their head/base
branch names and corresponding immutable head/base SHA. Stacked PR base SHA must
equal the parent's head SHA. A missing or wrong object, conflicting merge, moved
base, incomplete metadata or Git command failure is BLOCKED (exit code 2).

`CLEAN_DRY_RUN` (exit 0) means **only** that the particular frozen Git object
snapshot had no ordinary merge-tree conflict in this specific order. It does
not prove runtime API compatibility, safe CAS, real enrollment, owner consent,
OS containment, signed receipt validity, working installer, passing exact-head
CI, or a current GitHub HEAD. The generated simulated commits are never pushed.

Before an authorized real merge, refresh HEAD/base evidence, run the independent
exact-SHA CI audit, review full diffs and native test results, then rerun this
simulation on a fresh snapshot. Do not use the result as automatic merge approval.

## No-go boundaries

- Do not merge, rebase, push, tag, dispatch CI, modify actual devices, access
  credentials, restart services or toggle `CORE.active`.
- A restored SQLite WAL, fake fixture, local file ID, or green test is **not** an
  independent anti-rollback or physical authority proof.
- A missing native provider, current owner/session evidence, external CAS, or
  trusted revoke witness leaves CORE mutation dispatch **disabled**.

## Added P0 sibling: CORE native claim verification (#996)

Coordinator Draft #996 is based on #980 and is rehearsed after #985 but before
#990. Its additive D1 SQL migration and negative regression tests **do not**
activate CORE. A conflict-free tree only proves Git composition; the AI-06
native readback, Worker-side exact-identity CAS, signed current session and
physical effect-boundary evidence remain missing until independently proven.

## Post-release source merges and revised rehearsal (2026-11-01)

The following independently reviewed source PRs have been merged to **main**:
- **#986** WAL valid-recycle and SHM race checks, merge `ecba7688766563ab02157309bbe9d61db231faa5`.
- **#1002** journal-owner PID-incarnation/read-only startup, merge `0ddff39707d6c1298fb5788dcc06cf598b7c3bec`.
- **#994** exact-head CI/ownership checks and Windows namespace diagnostic, merge `93b6df33ef58610dcfdf3584bfe774e5afa7df4d`.

Their already-merged source heads must **not** be independently replayed
as new merge operations. A previous 19-PR script still attempted these
three and could report duplicate source conflicts. The revised **16-PR**
stack starts at the *current* main and tests only open unreleased CORE,
enrollment, CAS, QA and native sandbox dependencies. #1005 (CORE-side
journal-owner composition) remains a child of #980 and must still be
evaluated, because the shared CORE runtime can conflict with the now
main-integrated Agent behavior.

An isolated Git merge-tree result is never authorization to merge, deploy,
revoke, install or enable CORE. #974/#1001 remain OPEN until exact installed
signed Windows acceptance; the published v1.0.8 tag was not rewritten.
The earliest remaining conflict is a blocker and must be resolved without
blinding 'ours/theirs' or weakening AI-08 negatives.

## Current coordinator child PR coverage (2026-11-01)

The rehearsal includes latest-base child #1007 after #985 and #996, and
latest-base child #1004 after #990. Both children were refreshed with
non-destructive two-parent commits so no AI-owned branch was changed.
Their integration source and negative tests still require new exact-HEAD CI;
no source result is physical CORE consent or production authorization.

Parent HEAD movement during the snapshot is a BLOCKED signal. Never dispatch
another workflow when the same exact SHA/workflow/input is already active.
