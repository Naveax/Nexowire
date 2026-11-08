# #588 and #539/R15 — K19 P005 evidence and minimum live repro

Baseline: upstream `main` `b5a3f8840517d65ecbd6a018699c4c8bdde09987`
(`#1102` squash). This revalidates K19 Draft source tests from #1111/#1124
against that baseline by temporarily placing their exact test sources in a
clean main worktree; it **does not** mean either Draft is merged.

## Results by actual execution level (P005 T-503–T-507)

| Evidence | Actual result | What it establishes / does not establish |
| --- | --- | --- |
| #1111 `issue588-large-file-acceptance.test.ts` on new main | **5/5 local PASS** | Real filesystem `files.*` helper, isolated local paths, 221 KiB/1 MiB digest/chunks; NOT two authenticated PCs or a live client upload |
| #1124 `issue588-limits-inventory.test.ts` on new main | **5/5 local PASS** | Public 8 MiB cap vs internal 64 MiB helper vs 256 MiB ArtifactBridge; does NOT prove provider accepts a 220 KB upload |
| Main existing `cross-device-agent-file-io.test.ts` | **5/5 local PASS** | Native ranged reads and no-overwrite stage operations in local fixture |
| Main existing `cross-device-file-transfer.test.ts` + two earlier K19 contract suites | **21/21 local PASS** | Interruption, ACK loss, destination collision and reference status/copy rules; no live UI |
| `npm run typecheck`; `npm run build` on new main with K19 source tests overlaid | **PASS; PASS** | TypeScript source compatibility; not deployment |
| #1111 exact HEAD `c5119a65...` hosted CI run [42410254755](https://github.com/Naveax/Nexowire/actions/runs/42410254755) | **7/7 completed success** | Other CI jobs PASS; new `issue588-large-file-acceptance.test.ts` **NOT_RUN by CI discovery** |
| #1124 exact HEAD `4d1a3dc3...` hosted CI run [42411882607](https://github.com/Naveax/Nexowire/actions/runs/42411882607) | **7/7 completed success** | Other CI jobs PASS; new `issue588-limits-inventory.test.ts` **NOT_RUN by CI discovery** |
| Original user ~220 KB failure, ChatGPT/client, two real PCs/Windows, Hub authentication, actual UI filenames and final destination readback | **NOT_RUN / OPEN** | No end-to-end fix or customer acceptance claim |

Why **CI 7/7 ≠ K19 tests passed in CI:** current `package.json` runs
`node --test --import tsx test/**/*.test.ts`; the Linux shell expands this
without `globstar` and does not include two nested `test/delegated/k19/issue588-*.test.ts`
files. Current `.github/workflows/ci.yml` explicitly names two *older* K19 tests
but neither new file. Inspected actual `test (22)` job logs of both runs:
no `issue588` test-file invocation. The read-only negative and positive controls
in `p005-ci-discovery-qa.test.ts` reproduce this discovery gap. **K13 owns CI
workflow discovery**; this PR does not modify `.github/workflows/ci.yml`.

## Acceptance gates, without conflating test fixtures with real operation

1. **Bytes sent / ACK lost (T-505):** an interrupted second chunk or a publish
   without acknowledgement is `UNKNOWN`; do not display `COMPLETE` or promise
   resumability. Local negative verified in #1111 and previous K19 reference tests.
2. **Duplicate destination (T-505):** do not automatically overwrite. Existing
   file's bytes remain unchanged in local no-overwrite test; a remote EEXIST
   alone does not establish which content is present.
3. **Independent final digest (T-506):** a stored operation receipt is not a
   fresh destination readback. The separate writer after `COMPLETE` causes the
   receipt digest to disagree with subsequent bytes in local #1111 test. A
   real device must re-stat/hash its final target with authorized operations.
4. **Unicode basename / correct path (T-507):** 221 KiB Turkish + emoji filename
   and 1 MiB Unicode filename survive local path policies. The earlier K19
   reference test preserves graphemes and full accessible basename; the *actual
   screen* displaying correct source/destination paths remains **NOT_RUN**.
5. **CI (T-503):** exact SHA 7/7 is necessary but not sufficient. These new
   tests require a dedicated discovered CI invocation and log lines before they
   can be marked hosted PASS. Owner merger/issue closure remains separate.

## Minimum owner-controlled reproduction of the original incident (T-508)

No secrets, customer data, owner credentials or live machine access are needed
in a shared issue report. With explicit permission on two dedicated test PCs:

1. Record Nexowire installed build/commit, Windows versions, device IDs as
   **redacted identifiers**, client/provider, and whether the path is MCP
   `file_transfer_between_devices` or ArtifactBridge ingest. Capture the
   request/correlation ID and UTC timestamp; redact account/token details.
2. Generate a **non-sensitive** deterministic local 220–221 KiB file (and an
   additional 1 MiB case), use a Unicode filename, record original byte size
   and SHA-256 on the source PC. Select explicitly authorized devices and
   non-existing destination paths.

   Example PowerShell **on an owner-approved test PC** (creates only sample
   bytes in the current user's temporary folder, no customer files):

   ```powershell
   $sample = Join-Path $env:TEMP 'nexowire-221KiB-ışık-🧪.bin'
   $bytes = [byte[]]::new(221 * 1024)
   for ($i = 0; $i -lt $bytes.Length; $i++) {
     $bytes[$i] = [byte](($i * 13 + 17) % 251)
   }
   [System.IO.File]::WriteAllBytes($sample, $bytes)
   Get-Item -LiteralPath $sample | Select-Object FullName, Length
   Get-FileHash -LiteralPath $sample -Algorithm SHA256
   ```
3. Attempt the same public transfer twice: first on a stable link, then with a
   controlled interruption. Record tool input size cap, UI-visible status,
   error code, transferred-byte count, final publish/ACK receipt and retry
   behavior; do **not** assume an interrupted transfer is resumable.
4. Independently stat and SHA-256 hash the final destination on the receiving
   PC **after** the operation; record whether the old destination was preserved
   for a collision. If a remote readback is unauthorized, label result UNKNOWN.
5. Compare each layer's evidence: ChatGPT upload/provider preflight → MCP
   admission → Hub → native Agent file operations → final local disk readback.
   Log the first failing boundary with redacted request ID for #588.

Until those observations exist, local PASS + hosted unrelated 7/7 **cannot**
close #588 or #539/R15. Do not change transfer/auth/Agent source in K19 scope.
