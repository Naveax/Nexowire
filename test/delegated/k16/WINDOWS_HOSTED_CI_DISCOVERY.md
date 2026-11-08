# #540 T-485 — exact-head Windows test discovery (K16)

Source PR: [#1105](https://github.com/Naveax/Nexowire/pull/1105).
Observed PR head **before this report/test extension**:
`7eb4ba3263a55c4743582f6fec31b56ea8dcbdc3`.
Hosted [CI run #42412065818](https://github.com/Naveax/Nexowire/actions/runs/42412065818)
completed with **7/7 successful jobs** at that exact source SHA.

## Which tests actually ran?

| Requested evidence | Observed hosted evidence | T-485 gate |
| --- | --- | --- |
| Windows Node 24 runner exists | `browser-live` job `128522155631` completed successfully, running `windows-latest` with Node 24 per `.github/workflows/ci.yml` | Runner exists; **K16 tests NOT_RUN** |
| Windows Node 22 K16 test | No Windows Node 22 strategy/job in that CI file; Node 22 matrix is `ubuntu-latest` only | **NOT_RUN** |
| `windows-taskkill-contract.test.ts` launched on Windows | No explicit matching command in `ci.yml`; decoded full logs of Windows `browser-live` job and Linux matrix `test (22)` / `test (24)` jobs contain neither the K16 test path nor its T-346/T-387 TAP names | **NOT_RUN** |
| Existing native process-manager Windows tests | Windows `Physical Windows Job Object regressions` step completed | **PASS for that step only**, not T-485 or #540 owned grandchild postcondition |
| Owned root/descendant termination on a real Work-PC | No identity/creation-time/descendant-exit artifact in this K16 PR | **NOT_RUN** |

### Why a green CI is insufficient

The general project command is `node --test --import tsx test/**/*.test.ts`.
Its default bash one-level glob expansion does not select
`test/delegated/k16/*.test.ts` (two nested levels). The Windows CI's explicit
`browser-live` commands likewise do not include any K16 path. A future K13
delegated workflow may independently cover it; evaluate the *new exact commit*
and actual TAP output rather than inheriting this historical green result.

### Safe next validation

An approved CI owner (K13 / maintainer) can add an explicit unprivileged
Windows Node 24 and, if required, Node 22 *synthetic* test step:

```sh
node --test --import tsx --test-concurrency=1 test/delegated/k16/windows-taskkill-contract.test.ts
```

Require final TAP totals, zero failures/skips/TODO, exact checkout SHA,
and the real Windows runner labels. This command only exercises a mocked
`taskkill`/PID fixture. It does **not** prove physical descendant termination.
Only the protected owner may supply that independent evidence and decide #540.

No CI workflow, CORE source, live PID or service was changed in this task.

## P006 T-627 — later exact-run recheck (2026-11-08)

- PR #1105 updated head `96767f3c7acf344cf8070b0be7ff9959b103a4dc`:
  [run #42473773588](https://github.com/Naveax/Nexowire/actions/runs/42473773588)
  **7/7 CI jobs success**, including Windows `browser-live` job `128710444395`
  and Linux `test (22)` / `test (24)` jobs `128710444409` / `128710444489`.
  All three full job logs again contain **zero** occurrences of `test/delegated/k16`,
  `windows-taskkill-contract`, or the T-387 test label. Thus the *new* K16
  process-tree source/fixture coverage remains **HOSTED NOT_RUN** at that SHA.
- K13 independent [PR #1134](https://github.com/Naveax/Nexowire/pull/1134)
  reports fork auxiliary run `42474499872`, **4/4 success** with Ubuntu Node22/24
  source-discovery jobs. Its explicit list includes the **old**
  `test/delegated/k16/environment-doctor-contract.test.ts` (8 tests) plus a K09
  MJS fixture, **not** `windows-taskkill-contract.test.ts`. This is useful
  auxiliary hosted evidence for doctor source, **not Windows process-tree** or
  this PR's latest SHA.
- The owner #1096 `.github/workflows/ci.yml` draft has more Windows test jobs
  (including Node22/24), but its current tested commands also do not name K16
  `windows-taskkill-contract.test.ts`; draft code is **not merged**.

Require explicit test filename plus exact source SHA and runner OS/Node version
to upgrade the missing scope from NOT_RUN. A general 7/7 or auxiliary 4/4
status cannot substitute for that evidence.

## P007 D-093/D-094 — existing PR closeout audit (2026-11-08)

- [#1105 exact `06620d5a84f87bf6c06e7146c2dd052d95304c93`](https://github.com/Naveax/Nexowire/pull/1105)
  [CI #42485362697](https://github.com/Naveax/Nexowire/actions/runs/42485362697):
  **7/7 jobs completed/success**. Decoded full job logs for Windows
  `browser-live` job `128745939157` and Ubuntu Node22/24 jobs
  `128745939004` / `128745939041` contain **none** of the strings
  `test/delegated/k16`, `windows-taskkill-contract`, `T-625`.
  Therefore K16 Windows nested cases remain **HOSTED NOT_RUN** at this exact
  PR head, irrespective of the green general workflow.
- [#1121 exact `1b97d6341c036e1eadde491be1abfe743c716b7c`](https://github.com/Naveax/Nexowire/pull/1121):
  [CI #42411781654](https://github.com/Naveax/Nexowire/actions/runs/42411781654)
  7/7 jobs success, but its nested K16 `platform-status-evidence.test.ts`
  has no known explicit invocation. Source-only QA; K02 holds the single
  P004 T-385 credit. Current PR title/body were searched for GitHub
  `close(s)/fix(es)/resolve(s) #N` auto-closing verbs: **zero matches**.
- [Issue #540](https://github.com/Naveax/Nexowire/issues/540) fetched
  live via GitHub API: `state=open`, `closed_at=null`; source tests do not
  satisfy the physical Work-PC acceptance described in the issue.
- K13 [#1149](https://github.com/Naveax/Nexowire/pull/1149) separately
  demonstrates seven missing **main-tree** delegated tests on an auxiliary
  Ubuntu Node22/24 runner (2/2 jobs, 33/33 selected assertions). Neither
  that workflow nor upstream required CI proves the unpublished K16
  process-tree branch's Windows tests ran.

The above is a read-only result; no CI reruns, issue state change, PR merge,
or owner workflow edit was performed.
