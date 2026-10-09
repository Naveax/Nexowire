# Current-user DPAPI task definition recovery backup

P0: Issue #271. Hub handoff: #265. Broker: #260.

This helper saves a Windows Scheduled Task XML definition protected by the CURRENT USER's DPAPI key. It does NOT change a scheduled task or authorize a live cutover.

## Inspect (read only)

powershell.exe -NoProfile -NonInteractive -File scripts/backup-legacy-scheduled-task.ps1 -Mode Inspect -TaskName 'Nexowire Stack'

## Encrypted backup

powershell.exe -NoProfile -NonInteractive -File scripts/backup-legacy-scheduled-task.ps1 -Mode Backup -TaskName 'Nexowire Stack'

Under %LOCALAPPDATA%/Nexowire/recovery, creates a new unique legacy-stack-task-TIMESTAMP-GUID.dpapi encrypted task XML and a matching .dpapi.json metadata file with the non-secret task name, creation time, encrypted and original-data hashes and byte count. It never prints or writes plaintext XML, credentials, action arguments or protected token values.

The code validates recovery root directory ownership, untrusted write grants and reparse points, uses CreateNew + WriteThrough instead of overwriting old snapshots, and verifies encrypted digest and CurrentUser DPAPI decrypt/parse roundtrip before success.

## Verify only

powershell.exe -NoProfile -NonInteractive -File scripts/backup-legacy-scheduled-task.ps1 -Mode Verify -BackupFile 'legacy-stack-task-TIMESTAMP-GUID.dpapi'

Pass a backup filename, not a path. The helper validates the encrypted file, metadata and original XML integrity under the same Windows user without emitting the XML.


## Read-only rehearsal of the current task

powershell.exe -NoProfile -NonInteractive -File scripts/backup-legacy-scheduled-task.ps1 -Mode Rehearse -TaskName 'Nexowire Stack' -BackupFile 'legacy-stack-task-TIMESTAMP-GUID.dpapi'

The optional `Rehearse` mode validates the CurrentUser DPAPI encrypted backup, binds its manifest to the requested task name, path, purpose and envelope type, then **compares the backup XML digest with the currently registered Windows task definition**. It returns `activeTaskMatchesBackup: true|false` without exposing XML, command-line arguments, tokens or other task secrets. If the task cannot be read, the operation fails closed. No task is registered, restored, stopped, restarted, or modified.

**Limits:** This is a comparison-only rehearsal, not an actual restore test. Its output always has `rollbackRestorationTested: false`, `taskRestored: false` and `safeToCutover: false`. The backup is still bound to the same Windows user and its source files are not protected as elevated/system recovery material. A separate administrator-protected credential and runtime backup, isolated restore rehearsal, and explicit owner-authorized rollback are required for #271/#265.

## Limits

- CurrentUser DPAPI backup generally cannot be read under another Windows user or OS installation. It is not a SYSTEM-identity or independently protected administrator backup.
- Task XML does not include full OAuth secrets, private keys, DPAPI envelopes or validated service-token restore state. A separate authorized protected backup and rollback rehearsal is required.
- Task XML *may* contain sensitive action arguments. Those bytes are read in process memory then encrypted, never written to disk or printed as plaintext.
- Backup stored in the user profile is not equivalent to a high-integrity privileged rollback and does not prevent malicious same-user replacement.
- No task is restored, modified, started, stopped or re-registered. All outputs say safeToCutover=false and taskRestored=false.
- Keep the .dpapi and matching metadata files private. Do not upload backup blobs to GitHub or this chat.
- The independent production cutover checker must continue to report taskXmlBackedUp=false and protectedRollbackVerified=false until a protected backup and restore test is completed.
