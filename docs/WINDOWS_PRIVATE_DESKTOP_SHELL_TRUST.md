# Windows Private Desktop internal PowerShell trust

Private Desktop uses an isolated Windows desktop for Nexowire GUI interactions. Prior code invoked relative powershell.exe for the helper, private host, shell, input helper and Start Menu shortcut. A user-controlled PATH could substitute an interpreter and read private desktop input/request files or alter window behavior.

## Changes

- Pin all Nexowire-owned internal PowerShell launches, including host, private GUI shell, private input helper, general helper and Start Menu shortcut TargetPath, to C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe.
- The direct child processes use shell:false and a fixed Windows system executable search path and PSModulePath, never arbitrary PATH, PSModulePath or NODE_OPTIONS. A validated set of local absolute user profile/temp hints is passed for WPF, Add-Type and user-interactive compatibility.
- Explicit user-requested application launches still go through the existing application path resolver and validated private-desktop policy; they are not silently rewritten to Windows PowerShell.
- Existing private input HWND checks, private vs visible desktop separation, completion cleanup and shortcut behavior remain unchanged.

## Windows verification

On work-pc, 5/5 tests passed including real isolated desktop GUI start, window enumeration, simulated private pointer/keyboard interaction without switching the visible input desktop, and the internal subprocess/shortcut source contracts. TypeScript typecheck, build and diff checks passed.

## Limitations

Private Desktop is not Windows Secure Desktop and this source change does not grant kernel/root privileges, approve UAC dialogs, protect an entire executable/import tree or authorize a live elevated Stack cutover. No live Naveax Native Agent, desktop, scheduled task, Hub/Broker connection, identity secret or production ACL changed. P0 #271 remains OPEN.