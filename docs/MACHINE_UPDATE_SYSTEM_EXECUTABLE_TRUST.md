# Windows official machine updater executable trust

The privileged machine updater stages and extracts verified runtime packages, changes filesystem ACLs using icacls, and launches a detached Windows PowerShell cutover script. Previously these subprocesses were selected by relative powershell.exe / icacls.exe from caller PATH, permitting a user-selected executable or module path to substitute the tools used during a privileged update.

## Source hardening

- Both synchronous archive extraction and detached cutover use fixed C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe.
- Recursive ACL changes use fixed C:\Windows\System32\icacls.exe. The child receives only fixed system environment paths, no arbitrary caller PATH/PSModulePath, NODE_OPTIONS or other execution hooks.
- Subprocesses use shell:false and fixed System32 working directory. Synchronous tools use bounded time (180s) and captured output (2 MiB). Detached cutover remains detached and retains its existing update rollback contract.
- Existing official artifact hash checks, cutover script rendering and rollback semantics remain unchanged. No machine update was executed to test this change.

## Windows evidence

On work-pc, regression tests verify all three critical launch points and run the real Windows inbox PowerShell using a synthetic command with a fake powershell.exe prepended to the process PATH plus poisoned PSModulePath. Existing machine cutover and rollback script tests pass. TypeScript typecheck and build pass.

## Security limits

This change does NOT independently validate every target directory or inherited parent directory, release publisher provenance or ACL transition safety. In particular, machine update currently derives its ProgramData root from process.env.ProgramData and must be separately reviewed against arbitrary update roots. The source patch does not authorize live Highest Stack cutover and P0 #271 remains OPEN pending owner-approved protected runtime and tested high-integrity rollback.
