# Windows Node runtime ZIP extraction: release readiness repair (2026-11-19)

Observed exact upstream integration PR #1160 HEAD `4802faa06edca1f531a52cac56476d6b8573df91`, Release Readiness run [44517783233](https://github.com/Naveax/Nexowire/actions/runs/44517783233), Windows packaging job `135538186556` FAILURE. The bundled Node v24.22.3 archive download completed, then Windows PowerShell 5.1 `Expand-Archive` failed with `Cannot find an overload for ExtractToDirectory and argument count 3`. This is a real Windows build failure, not a physical SYSTEM Hub failure.

Change: separate HTTPS downloads from extraction. Read Node's published `SHASUMS256.txt` entry and compute local SHA-256 before extraction; reject unknown/mismatched archives without unpacking. Extract an approved ZIP into a new temporary destination with the Windows PowerShell 5.1-compatible `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(archive,destination)` two-argument method. Preserve existing runtime `node.exe` and `LICENSE` existence checks, cleanup policy, and bundle contents.

Tests: statically assert checksum-before-extraction order, safe path quoting and absence of the brittle `Expand-Archive` call; on Windows execute a disposable ZIP round trip via the actual `powershell.exe` 5.1 and .NET two-argument API. Hosted Release Readiness is required for real package acceptance; local synthetic tests are not enough.

Provenance: exact builder blob `2f2fc9e87fc334007f3b83bef949fac26e79e209` -> `3f71be3ce204e25b68fdf94d7bc33035e864f58f`; downstream AI05 CORE matrix blob `438f2cf177c23be794a4907c1a1bec713daedbb3` -> `7111249764d1b27c0272c3cf301cc4c5a844715b`; Round2 matrix blob `e459e5100f60a970306244d7b14ddef5f4f46b14` -> `74cea1c12bbccce95f6c0e8c9cd7c5fd3018298d`. Only the candidate blob fields for these changed files were refreshed, keeping source-of-origin references and existing semantic-review classifications. Physical Work-PC cutover remains NOT_RUN. No main merge or release publication.

## Native Windows CI invocation

The Windows job in `.github/workflows/release-readiness.yml` now explicitly runs `node --test --import tsx test/ci/windows-node-runtime-extraction.test.ts` with a three-minute timeout before building the user bundle. The Linux-only source assertion is not treated as evidence that Windows PowerShell 5.1 executed. An additional source regression pins the Windows-only step. A passing exact-head Windows job must confirm both the disposable native extraction and the actual signed-archive bundle build.
