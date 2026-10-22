# #02 — Independent Windows DPAPI hosted failure isolation (#683)

Date: 2026-10-21. QA source parent: DRAFT PR [#683](https://github.com/Naveax/Nexowire/pull/683), exact SHA `0eaa23a4401499279b0c9afeb8854be5a6ab7f49`. Previous #683 source-only CORE/Broker QA files remain unchanged. No #03 Job or #04 Access implementation changes.

## Exact-hosted failure, not a speculative elevation problem

[CI run #39644505625](https://github.com/Naveax/Nexowire/actions/runs/39644505625), Windows `browser-live` job `119376390482`: six of seven overall jobs succeeded. Windows native Job regression step and signed Broker/high-token **negative** step both succeeded. **One Windows job failed** in step `Verify Windows DPAPI and pre-logon Hub contracts`, which ran the **unchanged** three existing files `test/windows-dpapi-secret.test.ts`, `test/protected-secret-files.test.ts`, `test/hub-lifecycle.test.ts` together.

Raw hosted job output:
- `purpose-bound Windows DPAPI secrets round-trip and reject cross-purpose unprotect`: **FAIL**, 180044 ms, `WindowsDpapiError`, code `WINDOWS_DPAPI_FAILED`, thrown from `src/security/windows-dpapi.ts:219`.
- `Windows DPAPI round-trips current-user secrets without plaintext persistence`: **FAIL**, 180059 ms, same failure/code/source location.
- The step contained **22 tests: 18 PASS, 2 FAIL, 2 platform-conditional SKIP**. The existing skips were not introduced by this QA.
- `Windows DPAPI LocalMachine purpose-bound secrets round-trip` PASS (69990 ms); broker token ciphertext stability PASS (40468 ms), LocalMachine protected-secret PASS (38778 ms), protected-secret file PASS (89031 ms), and Hub/relay source bootstrap PASS (200121 ms).
- This does **not** establish whether the underlying Windows PowerShell child was starved, hung in DPAPI, waiting on user profile loading, or encountered a runner-specific OS condition. The public error deliberately redacts child stderr and coalesces nonzero exit/timeouts. Do not assert a root cause or a successful UAC/high-token claim.

## QA-only isolation, no skip or source modification

Add `test/qa-02-683-dpapi-timeout-negative.test.ts`: five deterministic source-only negatives with NO PowerShell child spawn. They verify that `WINDOWS_DPAPI_FAILED` has uncertain cause, cannot be considered authorization or a verified task effect, is never automatically replayed after possible mutation; correlations requestId/operationId survive; malformed purpose/ciphertext rejects before DPAPI invocation; hardened PowerShell child environment and bounded timeout are retained.

Add independent `.github/workflows/qa-02-dpapi-isolated.yml`, targeting the child pull request. On a fresh **GitHub-hosted Windows** runner, it runs **the same two existing DPAPI test files unchanged** sequentially, each with `node --test --import tsx --test-concurrency=1`, then the source-only QA negatives, using Node 22. Its purpose is to separate concurrent file execution contention from a genuinely recurrent CurrentUser DPAPI issue. There is no test deletion/skip and no raised timeout. In parallel, the repository's original full `browser-live` workflow remains unchanged, and its outcome must be reported independently. If the isolated DPAPI job fails, that remains a visible blocker, not a test to be hidden.

Original #683 negatives remain byte-for-byte identical: crash-persistent `requestId`/operationId `UNKNOWN` and no replay; forged physical UAC and token-witness separation; stale CORE owner epoch; ACK-vs-effect postcondition; real native provider only attests the inspecting PowerShell process, not installed Broker.

## Boundaries and decision

**No live local elevated shell, VM, UAC, ACL, installed Agent/Broker, ReVoltVPN-Ubuntu-Lab, production or main mutations.** The added workflow runs the pre-existing unprivileged DPAPI tests only on an ephemeral GitHub-hosted Windows runner. Runtime implementation under `src/` and owner `#03/#04` files are untouched. Physical CORE/Broker and VM production acceptance remains NO-GO, irrespective of QA CI. Local and exact-head GitHub results must be reported with their own SHAs and separate status.
