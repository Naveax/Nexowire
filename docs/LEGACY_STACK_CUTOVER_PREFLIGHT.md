# Legacy Stack handoff evidence (read-only)

Tracking GitHub Issues #271 (P0 unsafe runtime ACLs), #265 (Hub), #260 (Broker).
This is an inventory, not an installer, rollback or cutover approval.

## Operator invocation

From a checked-out repository on Windows, run scripts/inspect-legacy-cutover-readiness.ps1 with these named parameters, adjusted to the actual local installation:
- RuntimeRoot = C:\ProgramData\NexowireStack\nexowire
- Entrypoint = C:\ProgramData\NexowireStack\nexowire\node_modules\nexowire\dist\src\cli.js
- LauncherRoot = $env:LOCALAPPDATA\NexowireStack
- Launcher = $env:LOCALAPPDATA\NexowireStack\run-stack.ps1
- NodeExecutable = C:\Program Files\nodejs\node.exe

The one-object JSON output contains the Highest Stack task state and expected launcher reference (never full task arguments), Hub and Broker TCP listener owner PIDs, bounded runtime tree and parent ACL scans, SHA-256 of three known nonsecret executable artifacts, and Windows Node signature status.

No files, DACLs, tasks, tokens or processes are changed. The script does not read sensitive DPAPI token envelopes or export scheduled task XML. Its fail-closed blockers include both observed conflicts and pending owner approval, protected task backup and rollback validation. It always reports safeToCutover=false, privilegedOperationPerformed=false, credentialsInspected=false, taskXmlBackedUp=false, protectedRollbackVerified=false.

### Interpretation

The full-tree ACL inventories are conservative and do not compute Windows effective permissions, validate all dynamic imports/DLLs or attest a signed Nexowire release. Hashes of three nonsecret files are NOT a complete backup, and a signed Node executable does not prove JS code integrity. Port and task-state readings are snapshots and are not proof of sole process ownership at future launch time. An unavailable scan or unreadable task/port cannot be silently marked clean.

### Mandatory next steps before live switching

Under authorized elevated maintenance, capture an access-controlled task definition and DPAPI reference backup with no plaintext secrets, install a signed/verified code tree into a genuinely administrator-protected location, recheck ACLs after updater actions, prove working rollback, then approve coordinated legacy supervisor handoff. Do not install a second Hub task while Stack is running or launch user-writable staging source as SYSTEM. Only after cutover verify actual owner OAuth AUTO enable/disable/revoke, connected Agent and durable-process continuity, and Broker privileged health/ROOT TTL and audit separately.

This command is a read-only prerequisite, never authorization to elevate.