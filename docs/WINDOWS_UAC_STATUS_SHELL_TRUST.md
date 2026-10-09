# Windows UAC consent status PowerShell trust

The Windows UAC status check is read-only and does not approve consent dialogs. Before this source hardening it launched relative powershell.exe, allowing a caller-controlled PATH or PSModulePath to select substituted executables or CIM modules and falsify the observed count of consent.exe processes.

## Changes

- Pin C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe, shell:false and System32 working directory.
- Reset PSModulePath to the inbox Windows PowerShell modules and explicitly import the absolute CimCmdlets system module manifest, not a caller-selected module.
- Pass only fixed Windows system environment values, never caller PATH, PSModulePath, NODE_OPTIONS, user AppData or arbitrary hooks.
- Bound combined stdout/stderr to 64 KiB, maintain an eight-second subprocess timeout, and interpret inspection failures as unknown rather than clear or privileged authorization.

## Windows validation

Read-only consent process inspection succeeded on work-pc even when a fake powershell.exe was placed ahead of Windows in caller PATH and PSModulePath was pointed at an untrusted test directory; the fake file was not executed. 9/9 targeted tests, TypeScript typecheck and build passed.

## Safety boundary

The presence or absence of consent.exe cannot substitute for administrator approval. No automatic click, UAC bypass, task registration, privilege change or runtime deployment was performed. Legacy P0 #271 writable Highest Stack remains unresolved until owner-authorized protected full runtime/rollback and actual low-privilege write denial are verified.
