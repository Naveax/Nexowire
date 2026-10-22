# P1 #780 / #05: Task-scoped File API inventory and OS sandbox gap matrix

Evidence: #707 current owner File API, #780 product epic, #763 strict JSON, #765 signed installer/DPAPI, src/agent/executors.ts, path-policy.ts, scoped-path-grants.ts and existing Windows source-only retained-handle helpers.

**Path allowlisting is NOT an OS task sandbox.** New optional PathPolicyOptions.taskRoot is a trusted local library setting only, not available through remote tool JSON or wired into production task scheduling. It narrows inherited wildcard/default path roots, requires explicit owner/device locally issued grants for read outside, rejects directly reparse-linked task roots, blocks all task mutations pending a native OS-confined handle-relative executor and denies unrestricted process/WSL/shell execution. Existing non-task file API remains unchanged. Reads have a remaining post-path-check race.

| Risk / requirement | Existing File API and evidence | New opt-in taskRoot behavior | True OS sandbox status |
|---|---|---|---|
| Path containment / wildcard | realpath and path.resolve compare default allowed roots; wildcard broad | trusted task root overrides wildcard/default roots; outside file read denied | Kernel task-specific root not enforced; NO-GO |
| Outside-root grant | local owner/device, scopes and monotonic expiry via ScopedPathGrantRegistry; USB identity scoped | explicit separate owner/device grant permits outside-root read; mutations denied even with grant | Owner grant is not a native file handle sandbox |
| Junction/reparse/symlinks | existing realpath containment and post-volume recheck; real Windows TEMP junction tests | task root itself cannot be symlink/junction; outside junction targets deny | Ancestor can change after verification; no atomic RootDirectory native writer |
| ADS/UNC/devices | unsafeWindowsPath blocks ADS, device/UNC namespaces, drive-relative and DOS device names | same path check retained | OS-reported alternate stream and reparse resolution unavailable from protected importer |
| Hardlink aliases | read/write_at handle stat dev/ino and some nlink checks; import closure denies linkCount>1 | task writes disabled, legacy read checks intact | No complete aliases proof across links/volumes or share-mode fence |
| Open file ID / volume race | file read/hash/write_at use fstat, path policy resamples path, Windows volume resolver checks drive twice | additionally compare bigint dev/ino of task-root directory before and after authorization to reject TEMP rename/recreate with identical pathname; mutations remain denied | Not atomic with subsequent file open; no retained root directory handle, volume FileIdInfo/OS sandbox. |
| Importer ancestors and ACL | #707 synthetic per-DLL signer/hash/file ID/post-read and parent effective ACL; #763 strict JSON native read-only; #765 signed path exact set | does not accept read-only importer report as OS sandbox attestation | Separate lower-integrity effective AccessCheck, signed installed HIGH Broker, complete loader DAG unavailable |
| Child processes/network/hooks/Git | shell and process are not scoped by File API path checks | task-root mode denies unrestricted process/WSL, including prior lease | No AppContainer/restricted token/container namespace/macOS sandbox or network/env secret isolation |
| Existing mutation tools | fs.writeFile, fs.cp, fs.rename, fs.rm use pathname operations after preflight | blocked for taskRoot even within task root or local outside grant | Atomic parent handle-relative writer + safe rollback unimplemented |
| Physical protected execution | No installed attested signed high-integrity CORE Broker | no production hookup or elevation | #271/#551 PHYSICAL NO-GO |

## 2026-10-22 independent #786 Git-worktree root review and #05 repro

- #786 exact HEAD 8d5390dc8ed94e13ac380c6e37aa6f4de2888d4b, CI 39817020745 FAILURE, contains an intentional RED TEMP linked-worktree test: workspace.snapshot authorizes its requested task subdirectory and then uses Git-discovered --show-toplevel outside that scope without re-authorizing the returned root before reading its package.json. This is a **workspace/Git discovery ownership bug**, not evidence that taskRoot may expand. Keep the independent #26 test unchanged and preserve RED until the Git/workspace source owner fixes it; no edits to executors.ts Git discovery by #05.
- Separately, a *real #05 task-root read preflight* gap was reproduced in existing PathPolicy: a task directory renamed to task-original and immediately recreated under the same pathname in a synchronous owner-grant callback could bypass the existing path-text-only stability check. The TEMP-only negative was RED (Missing expected rejection) before the fix. The existing #05 source now captures bigint lstat dev/ino for taskRoot at entry and compares it after authorization, returning TASK_ROOT_CHANGED_DURING_AUTHORIZATION when the root handle identity differs, including after rename/recreate with identical path. No external/root user files or ACL touched.
- This **does not pin a Windows native directory handle** and does not stop a rename *after* the final check, nor a Git-discovered repository root beyond the task scope. Neither Linux/macOS process sandbox nor an installed protected Windows Broker is established. Root-volume serial, reparse follow-up, ADS, hardlink and native atomic writer remain blocked for real task mutation and physical HIGH.

## Acceptance boundary

- Source policy with taskRoot: LOCAL TESTS ONLY. This is a fail-closed preflight layer, not transitive OS isolation and not a complete P1 task worker.
- Task writes, child process, network, Git hooks, VM and unrestricted shell are NOT supported by this change.
- Real sandbox must separately prove actual OS low-privilege token restrictions, inherited process handles, root-relative atomic file mutation, owner epoch and durable reconcile before opening operations.
- #763/#765 successful source CI is not independent physical effective AccessCheck.
- Tests create and remove only unique TEMP fixtures. No user files, ACLs, USB devices, physical Broker, Agent configuration, or VM were modified.

## Tests

node --test --import tsx test/p05-task-root-file-policy-negative.test.ts test/path-policy.test.ts test/scoped-path-grants.test.ts

Run TypeScript/build and exact-head CI independently on the existing #707 branch. Do not create a duplicate PR.
