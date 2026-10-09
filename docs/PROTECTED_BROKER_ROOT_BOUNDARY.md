# Protected Broker task root boundary and removal guard

P0 #271 / Broker #260. This source-only check prevents the elevated Interactive/Highest Broker task installer and recursive uninstaller from following user-selected ProgramData or rootDir paths.

The only accepted Windows installation root is C:\ProgramData\Nexowire\privileged-broker. Other drives, relative paths, UNC paths, device paths, parent traversal, alternative folder names and user-controlled ProgramData base directories fail closed before privileged installation secret persistence or scheduled task mutation.

Before privileged installer writes and before task revocation, the root is inspected without changing it. Existing parent/root directory must be real directories, not ordinary Windows symlinks or junctions. All root entries must be regular files named launch.ps1 or task.json; any extra entries, folders or links abort deletion. The same check runs again immediately before recursive removal.

The preflight does not change or attest actual owner ACLs of C:\ProgramData\Nexowire parent or stop races with another privileged process. A successful check is not sufficient to authorize live cutover, and Windows object reparse coverage beyond normal symlink/junction types should be separately tested. A complete protected parent path, full installed runtime and actual denied low-privilege writes remain necessary.

Windows work-pc tests cover canonical path casing, malicious ProgramData override, UNC / device path, traversal, extra file/subdirectory/link refusal and real read-only task state; no live install/uninstall, secrets or existing scheduled tasks are touched.

Do not deploy on the live old Highest Stack until independently approved full runtime/rollback gates pass. P0 #271 remains OPEN.
