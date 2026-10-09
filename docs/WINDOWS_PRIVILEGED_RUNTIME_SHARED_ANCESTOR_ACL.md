# Trusted Windows runtime: ACL checks on shared OS ancestors

The privileged runtime verifier scans the signed Windows Node.js host, the CLI/import tree and all their ancestors. Windows C:\ and C:\ProgramData may grant ordinary users rights to create OTHER directories, including inherit-only generic rights that do not apply to the ancestor itself. Treating those permissions as permission to modify an already-protected descendant rejects legitimate protected runtimes.

## Safety correction

- Keep the complete write, append, delete, change-permissions and ownership-denial mask for every protected executable, code root, runtime directory, file and imported package.
- Only for the shared Windows filesystem root and exact C:\ProgramData, C:\Program Files and C:\Program Files (x86) shared ancestor directories, narrow the mask to DELETE, DELETE_CHILD, CHANGE_PERMISSIONS and TAKE_OWNERSHIP. Those are the rights capable of redirecting/removing a protected existing descendant. Ordinary sibling creation is not automatically such a right.
- Ignore inherit-only ACEs only on those shared ancestors. Such ACEs do not apply to the shared ancestor itself. The protected installed tree and its files continue to be inspected with the full rights mask including inherited permissions. If the shared ancestor itself is one of the supplied executable, CLI or code-root audit targets, the strict full mask is retained.
- Keep owner validation to SYSTEM, Administrators and TrustedInstaller, fixed Windows PowerShell and system Security module, full imported-code recursion, reparse rejection, and valid OpenJS Foundation signature on Node.exe.

## Verification

On work-pc, before this fix a real official signed Node.js at C:\Program Files\nodejs\node.exe and its protected npm package CLI were rejected by the old audit. The C:\ root has an inherit-only generic Authenticated Users ACE plus a limited CreateDirectories ACE. The updated audit accepts the protected installed 2,000+ file Node/npm tree while scanning its code/ancestors for writable ACLs and verifying the signed native Node publisher.

21/21 real Windows focused tests passed, including the installed protected Node/npm package and existing untrusted AppData path, fake marker, native Node signature, and machine-update ACL guards; npm typecheck/build and git diff --check passed.

## Limits

This does not approve writable runtime trees, bless arbitrary ProgramData roots, remove reparse/TOCTOU races, independently sign Nexowire JavaScript or authorize live Elevated Stack repair. The current live C:\ProgramData\Nexowire and NexowireStack roots have Authenticated Users Modify, so the full tree check must still refuse them. P0 #271 remains open.