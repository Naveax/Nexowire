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

The bootstrap registry sorts by provider priority, target availability, and capability. Later milestones add latency/health scoring, mutation policy, and operation idempotency.
