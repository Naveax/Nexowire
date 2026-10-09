# Windows DPAPI child-process trust and secret transport

Tracking P0 #271. The Nexowire Windows DPAPI adapter supports CurrentUser and LocalMachine encryption envelopes for protected service/broker secrets. The old adapter launched `powershell.exe` from inherited PATH for *both* its asynchronous and synchronous secret-processing routines. It also allowed the spawned child to inherit untrusted PowerShell/Node environment settings. Crucially, the DPAPI plaintext or ciphertext is transmitted through stdin, so selecting an attacker-provided executable would disclose sensitive input.

## Changes

- DPAPI helpers now invoke the fixed inbox `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` with `shell:false` and the Windows System32 working directory.
- Child environment pins OS-owned `SystemRoot`, `windir`, `ComSpec`, fixed system `PATH` and inbox-only `PSModulePath`. A few validated, local absolute user-profile and temporary-directory hints (`USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`) are retained for CurrentUser DPAPI and WindowsPowerShell compatibility on Windows hosted runners. These hints do **not** select an executable, PowerShell module, profile script (`-NoProfile`) or working directory; remote, relative, traversing and command-delimiter paths are discarded. Arbitrary caller PATH, `NODE_OPTIONS`, `NODE_PATH` and other process-injection variables remain excluded.
- Sync calls have a 180-second timeout and a 2 MiB output bound. Async calls have a timeout, combined stdout/stderr byte bound and terminate the child if the bound is exceeded.
- Failures return generic error messages instead of forwarding raw child stderr, which might accidentally contain plaintext or diagnostic data. Ciphertext parsing remains strict and canonical.
- All existing DPAPI entropy/purpose formats, CurrentUser/LocalMachine scope semantics, and public function contracts remain compatible.

## Windows verification

On work-pc, the real CurrentUser and LocalMachine DPAPI protect/unprotect paths were tested with **synthetic** secret values only, including synchronous and asynchronous unseal. A deliberately bogus `powershell.exe` was placed before real executables in the caller PATH; `PSModulePath` and `NODE_OPTIONS` were poisoned. Both scope round trips still passed via the fixed system shell, and the fake executable was not launched.

DPAPI, protected secret file, and broker regression run: 12 PASS, 2 skipped (tests for other platforms). TypeScript typecheck and build PASS. No real DPAPI/OAuth envelope was read or modified. No production Stack, Hub, Broker, Agent or Scheduled Task was stopped or reconfigured.

## Remaining security limitations

A protected PowerShell binary does not prove the calling Nexowire JavaScript runtime itself has independent, owner-approved publisher provenance, protected complete dependency tree or safe post-check behavior. DPAPI LocalMachine scope is not proof of per-process secrecy on the same host. Native DPAPI API usage through a trusted local host may eventually remove PowerShell entirely, but needs deliberate compatibility and rollback verification. This source-level patch is not deployed to the live Highest legacy supervisor.

**P0 #271 remains OPEN**. Protected full runtime installation, updater-safe ACL hardening, actual non-elevated denied-write proof and high-integrity recovery of real Scheduled Task and protected credentials are not yet established.
