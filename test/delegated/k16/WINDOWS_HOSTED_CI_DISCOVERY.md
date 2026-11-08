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
