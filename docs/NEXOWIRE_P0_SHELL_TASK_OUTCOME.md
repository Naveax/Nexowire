# P0: Explicit shell/WSL task outcomes on transport-successful MCP calls

## Problem
A successful Nexowire Agent/MCP response means the tool command was delivered, invoked and returned without a **protocol-level** error. It does **not** prove a shell program exited successfully. Previous reports included `ok:true` with `exitCode:1`, misleadingly interpreted as a completed successful task.

## Additive backwards-compatible contract

`src/providers/agent-provider.ts` now attaches **only for `shell.exec` or `wsl.exec`**:

| Field | Values | Meaning |
|---|---|---|
| `ok` | existing boolean | Nexowire request/Agent invocation succeeded; NOT a command-success guarantee |
| `exitCode` | number/null/absent | Process exit status reported by Agent; including native Windows crash values |
| `taskStatus` | `succeeded`, `failed`, `timed_out`, `unknown` | Explicit shell task outcome independent of transport |
| `taskSuccess` | `true`, `false`, `null` | Boolean interpretation of the task status; null = result not proven |

A known time-out takes precedence over a numeric exit code; exit zero without a time-out means `succeeded`, nonzero means `failed`. Missing/unconfirmed exit code without a reported timeout means `unknown`, **never succeeded by default**. Other native tools have no shell outcome fields. For native errors, `ok:false` continues to represent Agent/tool transport errors. `isError` at the MCP envelope remains backward compatible and is **not** used to reclassify a completed shell with exit code nonzero.

For example, a provider response `{ok:true,exitCode:7,taskStatus:"failed",taskSuccess:false}` is NOT a successfully executed task despite the MCP tool call itself being successfully delivered. Clients must check `taskSuccess` and the task's own postconditions. An exit-zero shell also does not prove higher-level acceptance: files/checkpoints/hardware require independent readback.

## Evidence and release gate

- `test/agent-provider-task-outcome.test.ts` contains AgentProvider unit matrix: exit 0, nonzero, Windows 0xC0000409, timeout overriding zero, missing/null exit status, non-shell isolation; plus a real in-memory MCP `shell_exec` contract integration that keeps `ok:true` while reporting `taskSuccess:false`.
- This is source-only until merged exact-head CI and compatible live Agent/Hub version have passed physical checks. Do not claim prior cross-project errors fixed solely by adding these fields.
- P1: the client/UI must render task status separately from transport health; a machine-readable Error Contract v2 origin/source taxonomy remains open for upstream OpenAI denials and native platform failures.

Maintains the native Agent protocol version and MCP v1 stable surface, since this is additive structured output metadata only.
