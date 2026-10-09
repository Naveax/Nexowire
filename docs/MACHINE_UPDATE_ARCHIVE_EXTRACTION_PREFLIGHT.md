# Machine update archive extraction preflight

The official machine updater already bounds the compressed ZIP download (256 MiB). However a small archive can inflate into excessive disk usage, include path traversal entries or symbolic link metadata that attempts to alter protected code outside the intended staging directory.

## Hardened extraction

- Before calling System.IO.Compression.ZipFile.ExtractToDirectory, open the ZIP only for metadata inspection using pinned inbox Windows PowerShell and .NET ZIP libraries.
- Reject more than 25,000 entries, any individual uncompressed entry larger than 128 MiB, or declared uncompressed total larger than 1 GiB.
- Reject blank entries, absolute/UNC/drive paths, parent-directory traversal and any entry whose normalized destination is not strictly within the target extraction directory. Refuse case-insensitive duplicate destination paths, reserved Windows device names (CON/NUL/AUX/etc.), and trailing spaces/dots before canonicalization.
- Reject symbolic links recorded in UNIX ZIP metadata. Release the ZIP handle in finally before calling the standard extractor.
- Preserve prior official checksum, signed Node/runtime protection, trusted root ACL, bounded HTTP streaming, task plan, listener PID and rollback controls.

## Isolated real Windows validation

10/10 dedicated tests pass on work-pc using actual disposable Windows ZIP files and PowerShell 5.1 extraction. A normal ZIP is extracted within its temporary test directory. Parent traversal, absolute paths, forged >128 MiB single-file metadata, nine forged 128 MiB entries (>1 GiB total) and UNIX symlink external attributes all refuse extraction. No real update, protected task, root ACL or user credential modified.

## Limitations

ZIP central directory sizes are declarations. This bounded preflight is not a complete filesystem-space reservation or atomic defense against all races and nested archive structures. The exact official release payload and publisher still require independent approved signer and full installed runtime verification. Real low-privilege denied write and privileged task/secret recovery remain gating requirements for P0 #271.