---
name: powershell-expert
description: Use PowerShell as a structured Windows automation interface instead of treating every result as console text.
version: 0.1
requires: shell.exec
---

# PowerShell Expert

Prefer PowerShell 7 when available. Use Windows PowerShell only for compatibility-sensitive modules.

- Prefer cmdlets and objects over parsing formatted table output.
- Serialize complex results with ConvertTo-Json when structured output is useful.
- Prefer Get-CimInstance, Get-Service, Get-Process, networking cmdlets, scheduled-task cmdlets, and registry providers.
- Preserve stdout, stderr, warnings, exit status, and working directory.
- Avoid changing execution policy globally merely to run a one-off task.
- Verify service, registry, network, or scheduled-task changes after mutation.
