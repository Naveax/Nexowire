# Highest/SYSTEM Hub boot runtime source gate

Related: P0 #271 and Hub handoff #265. This gate is **not** the
replacement for an approved runtime signing, upgrade and rollback plan.

Before the existing `hub boot-install` command reads a current-user DPAPI
service-token envelope, writes a machine DPAPI secret or registers a
Windows SYSTEM Scheduled Task, it now performs a synchronous
**read-only Windows source-integrity preflight**.

The preflight:

- rejects relative, UNC, user-profile, AppData, temporary, and arbitrary
  non-system-install locations even if the caller manually supplies those paths
- anchors candidate locations to **C:\\Program Files**, **C:\\Program Files (x86)**
  or **C:\\ProgramData**, without trusting caller-overridden ProgramData,
  ProgramFiles, SystemRoot, WINDIR or PATH variables. Other Windows system
  drive layouts currently fail closed rather than loading a PowerShell binary
  from an unverified location.
- identifies the CLI package root and, for installed node_modules packages,
  includes all sibling packages under the outermost node_modules parent
- launches its fixed Windows PowerShell executable from the trusted System32
  working directory with a narrowly allowlisted environment, instead of
  inheriting caller-controlled PSModulePath, PATH, APPDATA, TEMP, or Node hooks.
  The diagnostic pins the built-in WindowsPowerShell module directory and
  imports the inbox Microsoft.PowerShell.Security module by an absolute path,
  preventing caller-injected module lookup before Get-Acl.
- checks the executable, CLI and their ancestor directories for unexpected
  owners, untrusted allow-write ACEs and reparse points
- also enumerates all files/directories in the resolved code package tree and
  the executable's directory tree (up to 20,000 distinct audited objects)
- validates the Windows Node executable's `Valid` Authenticode signature and
  pins the expected `OpenJS Foundation` code-signing publisher identity. A
  Microsoft-signed or third-party-signed but otherwise unknown executable
  is not accepted as the privileged Node host. A changed legitimate Node
  signing identity must be independently reviewed before updating this policy.
- accepts only the exact `TRUSTED_RUNTIME_CODE_TREE` result marker from the
  isolated Windows PowerShell preflight. Partial, appended or failed-command
  output never satisfies the protected runtime trust gate.
- forbids Node startup `execArgv` flags (such as `--require`, `--import`,
  `--loader`) and removes inherited `NODE_OPTIONS`, `NODE_PATH` and
  related Node preload/certificate/ICU configuration from the SYSTEM child
  launcher before executing the protected runtime.
- refuses the protected task installation if any file/ACL enumeration fails
  or the runtime tree exceeds the safety cap.

The Hub Boot Scheduled Task lifecycle also invokes a fixed
`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` for
status, registration and removal, rather than resolving `powershell.exe`
from the caller's PATH. Lifecycle task invocations use a strict system
environment containing only pinned Windows system paths/module root and
the three required boot task name/user task name/protected launcher path
variables. The registered task action also references that exact trusted
PowerShell binary. This reduces executable-search and user-module-loading
risk when the lifecycle operation is authorized to run elevated. It does
not grant consent or change the requirement for an administrator-approved
protected installation.

It never changes a live permission, decrypts a token or runs the candidate CLI
during validation. A failed preflight does not rewrite an existing Hub task.

**Limitations:** the audit is deliberately conservative and does not compute
Windows effective-token/deny-ACE semantics or independently attest the
Nexowire JavaScript package's own publisher/signature. The Node executable's
OpenJS Foundation signature is checked, but this does not sign the JS package.
It does not guarantee all dynamic imports or DLL search paths resolve within
the scanned roots, prevent post-check time-of-check/time-of-use races or assert
production ownership and rollback. In particular a user-writable staging
checkout, even with a valid source Git SHA, is **not** a valid privileged
runtime. These checks are a fail-closed barrier, not a complete trusted
installer or permission-migration implementation.

## Protected Hub Boot directory scope

Privileged Hub Boot status, installation and removal must resolve their managed
directory to exactly `C:\ProgramData\Nexowire\hub-boot`. Relative,
UNC, arbitrary drive, caller-selected temporary or user-profile `ProgramData`
overrides fail closed. Installation verifies this before any protected token
unseal, directory creation or task mutation.

Before the uninstall task operation and recursive directory removal, the
existing protected root must also be a real directory (not a symlink or
junction) and contain only expected flat lifecycle files: `launch.ps1`,
`lifecycle.json`, `hub.pid`, and the machine-scoped service token envelope.
Unknown files, directories or linked children fail closed. This guard is
not an ACL verifier, does not prove the root/ancestors cannot be renamed
after validation, and does not grant permission for a live cutover.

## Real installation implications

The existing Naveax v1.0.0 Stack supervisor executes writable code in
`C:\ProgramData\NexowireStack` as a Highest task. Its ACLs are not
repaired by this PR. The running Stack continues unaffected, including its
Hub, Broker and durable workers.

The new guard also does not make the current user's v1.0.5 AppData path a
safe SYSTEM boot source. A verified runtime must first be installed by an
owner-authorized privileged installer into an admin-protected, fully audited
location, with its service-token scope and rollback addressed separately.

A successful preflight is **not** authorization to switch supervisors. The
independent legacy Stack/port guard from Issue #265 remains in force.
