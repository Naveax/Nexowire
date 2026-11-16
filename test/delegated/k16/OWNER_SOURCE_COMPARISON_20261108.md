# #540 T-628/T-630 — protected owner source and minimal repro handoff (K16)

This file is **read-only evidence**, not a request to modify `src/agent/process-manager.ts`
or `.github/workflows/ci.yml` from K16.

## Compared exact refs (2026-11-08)

| Reference | SHA | Meaning |
| --- | --- | --- |
| Current upstream `main` | `52d452f717d891eeaf4c2b9aff3c6e1ea68369b0` | Merged baseline; owner #1096 not merged |
| Protected owner PR #1096 head | `e879ecb8e70a0e798c73c6028400b11e3e8bb4e7` | Draft Windows CORE/Job candidate, **not** installed-device acceptance |
| K16 source-test PR #1105 previous exact head | `96767f3c7acf344cf8070b0be7ff9959b103a4dc` | Local fixtures, no native owner code changes |

Read-only `git diff --numstat main owner-head --` results:

- `src/agent/process-manager.ts`: **88 insertions, 30 deletions**.
- `.github/workflows/ci.yml`: **293 insertions, 2 deletions**.

Owner candidate adds guarded Windows Job launch and guardian/root lifecycle
handling; this is **not** a claim of successful descendant incarnation
readback. Its private `killPidTree` still reports only `requested` on `taskkill`
exit zero and `unconfirmed` on root-gone nonzero. It does not interrogate
each owned descendant's PID+creation time in that path. Owner CI includes
Windows Node 22/24 test jobs but **does not explicitly run**
`test/delegated/k16/windows-taskkill-contract.test.ts`.

## Minimal owner-safe reproduction

1. On the K16 test branch (not a real machine), run
   `node --test --import tsx test/delegated/k16/windows-taskkill-contract.test.ts`.
   The actual private `killPidTree()` source is transpiled into a mock VM;
   root/descendant identities are fake, and no OS process is signaled.
2. T-625: mock exit zero, gone parent and live grandchild; record only
   `requested` and no descendant-PID liveness readback. **Do not emit confirmed success.**
3. T-626: mock `Access is denied` with (a) root absent and (b) root live;
   expect `unconfirmed` or `PROCESS_TREE_TERMINATION_UNCONFIRMED` respectively.
4. Protected owner may translate these scenarios into isolated disposable
   Windows Job tests with per-PID creation-time proof, all-descendant exit,
   native Job readback and final TAP exit. See
   `WINDOWS_PROCESS_TREE_ACCEPTANCE.md` for exact evidence gates.

## Result and handoff

K16's synthetic `requested`/`unconfirmed` paths do **not** close issue #540.
The required next owner action is to demonstrate bounded, independent exit
of the *exact original owned descendants*, prove no unrelated process was
signaled, and show actual Windows Node22/24 test discovery on a new exact
checkout SHA. If no safe physical test environment exists, mark **NOT_RUN**.

No CORE, CI, Job ownership, Windows process, security, auth, release, or
deployment mutation was performed by K16.

## P007 D-091/D-095 — current owner head and no file collision

Read-only `git ls-remote` / `git diff` after P007 replaced the earlier
#1096 head with **`b675897dce171a4f5e7a7ccb3187a16ac13630d0`**.
Upstream main was still `52d452f717d891eeaf4c2b9aff3c6e1ea68369b0`.
At this newer owner SHA, `process-manager.ts` is **88 insertions / 30 deletions**,
owner `.github/workflows/ci.yml` is **304 insertions / 14 deletions** relative
to main. Owner PR's changed files include the two protected paths, but
**zero** files under `test/delegated/k16/**`; #1105 has four K16-only paths
and #1121 has one K16-only path. No same-path collision; **semantic**
ProcessManager/Job behavior and CI test-discovery dependencies remain open.

Owner minimal delta for review, not a K16 source change:

1. Treat a `taskkill` exit-zero as **request** until exact owned descendant
   PID+creation-time readback confirms all descendants exited.
2. If a detached child survives after root exits, return an unconfirmed/
   explicit failure result and preserve session/Job ownership identity;
   do not blindly kill by a recycled PID.
3. Include the explicit K16 nested test file under a reviewed Windows
   Node22/24 CI command and capture final TAP exit. The current owner
   `ci.yml` candidate still does **not** name
   `test/delegated/k16/windows-taskkill-contract.test.ts`.

This note is a QA handoff to ŞEF/Ömer, not a permission to patch #1096.
