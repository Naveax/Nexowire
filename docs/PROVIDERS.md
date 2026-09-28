# Provider Model

A provider answers two questions: which targets are online with which capabilities, and can it execute one normalized capability request for a target?

The current `native-agent` provider is the reference implementation.

## Planned providers

### Native Agent
Direct outbound WebSocket agent. This is the provider Nexowire fully controls and can extend with process sessions, GUI control, events, and hardware APIs.

### Remote Desktop Commander
Adapter when a supported programmatic interface is available. Nexowire must not assume ChatGPT connector authorization can be reused server-to-server.

### SentinelX
Adapter for supported host capabilities. Provider-specific command formats remain behind the adapter.

### Local / WSL / SSH
Future providers implement the same interface without adding duplicate ChatGPT-facing tool names.

## Routing

The registry filters by target/capability, checks provider health before execution, ranks equal-priority candidates by reported latency, and automatically fails over retryable **read-only** operations. Once a mutation has been sent, an ambiguous disconnect or provider exception becomes `MUTATION_STATE_UNKNOWN`; Nexowire deliberately refuses to replay it through another provider until state is verified. Explicit idempotency records remain a later milestone.
