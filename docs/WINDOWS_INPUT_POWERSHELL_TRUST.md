# Windows clipboard and keyboard subprocess trust

The Windows clipboard and keyboard adapter previously resolved powershell.exe via the caller-controlled PATH. The child consumes clipboard or requested typing data via stdin and invokes System.Windows.Forms / native SendInput, so an unexpected executable or module is a serious confidentiality and input-integrity boundary.

## Source changes

- Pin every input subprocess to C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe, with shell:false and fixed System32 working directory.
- The child environment pins SystemRoot, windir, ComSpec, PATH, and PSModulePath to Windows inbox paths. User profile and temp directory hints are permitted only when they are simple local absolute Windows paths without parent traversal or command delimiters; this preserves Add-Type / Windows Forms compatibility.
- No caller-selected PATH, PowerShell module path, NODE_OPTIONS, NODE_PATH or arbitrary hooks can choose the interpreter or imported code.
- Bound combined child stdout/stderr to 2 MiB; fail closed if exceeded. Existing input operation timeout, target HWND/foreground checks and SAFE/FULL capability policy remain unchanged.

## Verification

Work-pc Windows tests: 9/9 PASS including rejected invalid keyboard HWND under a deliberately fake powershell.exe first in PATH, unsafe temporary-profile input validation, bounded clipboard read and a controlled Notepad typing/hotkey save exercise with synthetic text. TypeScript typecheck and build passed.

## Live boundary

This changes source code only and does not send keyboard or clipboard mutations to live Naveax, nor stop or reconfigure Agents, Hub, Broker, Scheduled Tasks, or production secrets. It is not a protected elevated runtime cutover; P0 #271 remains unresolved until owner-authorized full protected installation with effective non-admin write-denial and tested rollback.
