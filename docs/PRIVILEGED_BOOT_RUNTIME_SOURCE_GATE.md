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
- checks the executable, CLI and their ancestor directories for unexpected
  owners, untrusted allow-write ACEs and reparse points
- also enumerates all files/directories in the resolved code package tree and
  the executable's directory tree (up to 20,000 distinct audited objects)
- refuses the protected task installation if any file/ACL enumeration fails
  or the runtime tree exceeds the safety cap.

It never changes a live permission, decrypts a token or runs the candidate CLI
during validation. A failed preflight does not rewrite an existing Hub task.

**Limitations:** the audit is deliberately conservative and does not compute
Windows effective-token/deny-ACE semantics or attest Authenticode signatures.
It does not guarantee all dynamic imports or DLL search paths resolve within
the scanned roots, prevent post-check time-of-check/time-of-use races or assert
production ownership and rollback. In particular a user-writable staging
checkout, even with a valid source Git SHA, is **not** a valid privileged
runtime. These checks are a fail-closed barrier, not a complete trusted
installer or permission-migration implementation.

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
