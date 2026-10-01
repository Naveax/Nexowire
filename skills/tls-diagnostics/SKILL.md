---
name: tls-diagnostics
description: Diagnose HTTPS/TLS reachability, certificate, hostname, protocol, and proxy failures without weakening transport security as a shortcut.
version: 1.0
requires: network.dns.resolve, network.tcp.probe, network.http.probe, shell.exec
platforms: any
mutation: read-only
privilege: user
trust: trusted
tags: tls, https, network, certificates, diagnostics
---

# TLS Diagnostics

Use this workflow for certificate errors, HTTPS connection failures, hostname mismatches, trust-chain problems, or TLS handshake failures.

## Workflow

1. Resolve the hostname with `network.dns.resolve` and record the addresses actually returned.
2. Probe TCP reachability to the exact destination port.
3. Use `network.http.probe` against the intended HTTPS URL and preserve status/error metadata.
4. Separate failure classes:
   - DNS resolution
   - TCP reachability
   - TLS handshake
   - certificate hostname/trust/expiry
   - HTTP response/application
5. If certificate detail is required, use a bounded read-only platform command such as OpenSSL or native certificate tooling.
6. Check proxy/environment configuration only when evidence points to interception or route differences.
7. Compare the requested hostname with certificate SANs rather than relying on a human-readable CN assumption.
8. Verify the final HTTPS endpoint after any external configuration change.

## Safety

- Do not disable certificate verification to make a test pass.
- Do not replace HTTPS with HTTP as a diagnosis.
- Do not install a new root CA unless the operator explicitly intends to trust that authority.
- Avoid logging bearer tokens, cookies, client certificates, or private keys.
- A certificate may be cryptographically valid and still be wrong for the requested hostname.
