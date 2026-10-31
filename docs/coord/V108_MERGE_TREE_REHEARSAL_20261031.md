# Nexowire 1.0.8 | Offline merge-tree rehearsal

**Status: NON-DESTRUCTIVE SOURCE SIMULATION. NEVER A MERGE OR RELEASE PERMIT.**

This coordinator-owned tool checks whether the current **13-PR dependency DAG**
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
   for id in 986 980 981 982 988 983 984 993 989 987 992 985 990; do
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
986,980,981,982,988,983,984,993,989,987,992,985,990 | ForEach-Object {
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
