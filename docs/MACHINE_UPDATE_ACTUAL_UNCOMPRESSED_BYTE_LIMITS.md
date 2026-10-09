# Machine update: enforce actual decompressed byte budgets

The protected ZIP update flow had preflight size limits based on central-directory declared ZipArchiveEntry.Length, but then separately reopened the ZIP to call ZipFile.ExtractToDirectory. The preflight alone does not independently bound actual bytes produced by the entry streams and introduced a second file open after inspection.

## Source-only change

- Open the verified ZIP once and retain its .NET ZipArchive file handle for both the complete preflight pass and the extraction pass.
- Keep all existing path, entry count, per-entry declared byte, total declared byte, Windows device alias, duplicate target, traversal and symlink checks. Refuse directory entries with nonzero declared data.
- After the complete preflight accepts every entry, stream each file through a 64 KiB byte buffer to a newly created file under the canonical staging extraction root. Bound actual received decompressed bytes to 128 MiB per file and 1 GiB total; do not depend on the metadata length alone.
- Reject an actual byte count that differs from the ZIP entry's declared byte length. Use FileMode.CreateNew rather than overwriting a pre-existing destination. Dispose input/output streams in finally blocks and dispose the original ZipArchive after extraction/failure.
- Run extraction only under the existing randomly named protected machine-update staging root after existing official SHA-256, ProgramData trusted-root and administrative filesystem checks.

## Real Windows verification

43/43 combined isolated Windows regression tests passed, including normal ZIP extraction, unsafe entry names, symlinks, forged huge metadata, case collisions, explicit synthetic lowered limits activated after preflight to verify actual per-file and aggregate streamed-byte guards, and central-directory length mismatch rejection. Typecheck and build passed.

An additional independent work-pc-only compatibility test downloaded the official v1.0.5 Nexowire-Windows-x64.zip (40,978,916 bytes) to a disposable temporary directory and extracted the entire archive using this exact new streaming extraction function. Result PASS in approximately 4.5 seconds; 4,099 real files were extracted and both runtime/node.exe and app/dist/src/cli.js existed. The temporary file/extraction directory was deleted after verification. No package code was executed.

## Limits

Preflight and extraction in one open handle reduce ZIP file substitution but do not eliminate arbitrary filesystem races or prove a full independently signed Nexowire JS publisher. Disk capacity, running native Node signer, real ordinary-user write denial, administrator-owned Highest task and OAuth/DPAPI rollback must be separately verified before production P0 #271 closure. This does not run a real update or alter any live service.