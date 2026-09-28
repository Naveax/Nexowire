# Nexowire Architecture

Nexowire is an AI-facing control plane, not a remote-desktop protocol.

## Data path

```text
ChatGPT
  -> MCP / HTTPS
Nexowire Hub
  -> provider registry
  -> capability router
  -> native agent / future provider adapter
Target computer
```

A target can eventually be reachable through more than one provider. The provider registry normalizes those transports into the same capability model.

## Current bootstrap

- stateless Streamable HTTP MCP endpoint
- stdio MCP mode for local development
- outbound native-agent WebSocket transport
- provider registry with deterministic priority and exception failover
- PowerShell/cmd/bash shell execution
- interactive process sessions with incremental output, stdin, stop, and list
- WSL2 command execution
- allowlisted file read/write/list
- machine and Git workspace snapshots
- persistent workspace checkpoints
- lazy skill discovery

## Design rules

1. Provider-specific details do not leak into the normal ChatGPT tool surface.
2. Structured APIs beat GUI automation; GUI automation beats raw coordinate control.
3. Reads can fail over aggressively. Unknown-state mutations require verification before replay.
4. Long-lived project context belongs in workspace checkpoints, not assumptions.
5. Tool output is bounded.
6. The native agent initiates outbound connectivity so target PCs do not need inbound public ports.

## Next architectural layers

- durable task/job engine with event subscriptions
- process retention/recovery across agent restarts and richer event subscriptions
- structured Windows service/process/network/registry tools
- provider adapters for SentinelX and Remote Desktop Commander where supported APIs permit
- GUI accessibility tree plus screenshot/computer-use fallback
- production ChatGPT authentication and encrypted credential storage
