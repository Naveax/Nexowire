---
manifest_version: 2
name: network-troubleshoot
description: Diagnose connectivity from the target computer with structured DNS, TCP, HTTP, and machine-health probes before falling back to shell commands.
version: 0.1
requires: machine.health, network.dns.resolve
requires_any: network.tcp.probe | shell.exec; network.http.probe | shell.exec
prefers: network.tcp.probe, network.http.probe
platforms: any
mutation: read-only
privilege: user
trust: reviewed
tags: network, dns, tcp, http, diagnostics
concurrency: parallel-safe
replay: safe
---

# Network Troubleshoot

Use structured probes first. They are faster to interpret and far less fragile than scraping ping, curl, nslookup, or PowerShell table output.

## Workflow

1. Read `machine_health` when the symptom could be caused by local resource pressure.
2. Resolve the hostname with `network_dns_resolve`.
3. Prefer `network_tcp_probe` for the exact destination port; use a bounded shell fallback only when that structured capability is unavailable.
4. If the service is HTTP(S), prefer `network_http_probe` for status, redirects, timing, content type, and a bounded body preview; use shell only when the structured probe is unavailable.
5. On Windows, combine this with `windows_network_snapshot` when adapters, DNS servers, routes, or active TCP connections matter.
6. Only use shell commands for protocol-specific diagnostics that the structured tools do not expose.

## Interpretation

- DNS failure with a healthy network path points toward resolver/name configuration.
- DNS success plus TCP failure narrows the problem to routing, firewall, listener, or destination availability.
- TCP success plus HTTP failure narrows it to TLS/HTTP/application behavior.
- A redirect is not automatically a failure. Inspect the status and Location, then follow it only when useful.
- High local CPU or memory pressure can make network symptoms misleading, so correlate with machine health.

## Safety

- HTTP probes accept only HTTP(S) URLs and reject embedded credentials.
- GET body previews are bounded. Increase the limit only when the body itself is relevant.
- Prefer HEAD when status and headers are enough.
- These probes are read-only diagnostics. Do not turn a connectivity check into a configuration mutation without separate evidence.
