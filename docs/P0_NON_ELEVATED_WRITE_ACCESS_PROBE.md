# P0 Windows non-elevated effective write-rights probe

Issue #271. This is **read-only access evidence**, not a protected installer, ACL repair, rollback or permission to cut over Hub/Broker.

## Purpose

Conservative ACL inventory catches allow-write ACEs but does not prove what an actual ordinary Windows access token can open. This script requests individual potentially dangerous access rights using the Windows kernel32 CreateFileW API with OPEN_EXISTING: no FileStream write, rename, delete, Scheduled Task or DACL mutation.

The probe uses the caller's current Windows token and refuses SYSTEM or enabled Administrators group tokens. A check made under an elevated token cannot establish an ordinary user's effective rights. It does not impersonate, change UAC, change identities, request privileges, or enumerate secrets.

## Example

In a verified local checkout, as a genuinely non-elevated user:

    powershell.exe -NoProfile -NonInteractive -File .\scripts\probe-windows-unprivileged-write-access.ps1 -RuntimeRoot 'C:\ProgramData\NexowireStack\nexowire' -Entrypoint 'C:\ProgramData\NexowireStack\nexowire\node_modules\nexowire\dist\src\cli.js' -FullTree -MaxObjects 10000 -MaxReportedFindings 40

The executable tree could contain more than 10,000 objects. Raise MaxObjects (up to 20,000) only if justified. An incomplete enumeration throws and does not return a clean result.

The script checks separately file WRITE_DATA, APPEND_DATA, WRITE_EA, WRITE_ATTRIBUTES, DELETE, WRITE_DAC and WRITE_OWNER. For directories it requests ADD_FILE, ADD_SUBDIRECTORY, DELETE_CHILD, WRITE_ATTRIBUTES, DELETE, WRITE_DAC and WRITE_OWNER. It checks the entrypoint, entrypoint ancestor chain, runtime root, optional full tree, and root ancestors up to volume root. It refuses linked/junction objects; a full tree scan stops at any such object.

An attempted handle open returns:
- GRANTED: this specific ordinary user token was able to acquire the requested right at that instant.
- ACCESS_DENIED: the kernel refused the specific right (no finding for that right).
- INCONCLUSIVE: a different error occurred, such as a sharing violation. It is not evidence of denial.

Output uses redacted component labels such as @entry, @entry-parent/N, @tree/N, @outer-parent/N. It does not disclose task definitions, credentials, absolute code paths, account names or user SID. allProbedRightsDenied=true means only that these requested rights were denied by this one token, at this instant, for all fully probed objects; it is not a durable attestation or complete Windows security proof. Reports unconditionally say authorizedToElevate=false, safeToCutover=false, restorationTested=false.

No file contents are deliberately modified. The act of opening a Windows file handle may cause OS-dependent access metadata updates. This probe cannot prove that every Windows account, service token, updater, ACL deny/allow combination, rename race, alternate data stream, network share, dynamic import or load-time dependency is safe. Use ACL tree audit, independently verified release provenance, protected ACL and separate real rollback acceptance alongside it.

## Real Naveax diagnostic evidence (2026-10-09)

A non-elevated Naveax interactive connection was confirmed and a separate in-memory, three-right CreateFileW probe on the live legacy cli.js was executed without changing content, DACL or task state:

| Requested right | Result |
| --- | --- |
| WRITE_DATA | GRANTED |
| DELETE | GRANTED |
| WRITE_DAC | ACCESS_DENIED |

This directly supports the P0 #271 unauthorized-write risk for that specific non-elevated Windows user token. The full-tree probe was not run against live Naveax. The production permission migration is not done.
