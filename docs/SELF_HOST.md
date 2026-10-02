# Self-hosted Nexowire node

A self-hosted node runs the Nexowire Hub and the local Native Agent on the same Windows account. The Hub stays bound to loopback. Optional Tailscale Funnel exposes the authenticated MCP endpoint without opening a router port or persisting plaintext bearer tokens.

## One-command bootstrap

```powershell
nexowire node bootstrap --device-name work-pc --tailscale-funnel
```

Optional flags:

- `--allow-root <path>` may be repeated. The Windows user home is used when omitted.
- `--port <1-65535>` changes the loopback Hub port from the configured/default port.
- `--ttl-days <1-365>` controls the initial MCP and native-agent credential lifetime.
- `--tailscale-funnel` requests public HTTPS MCP exposure through Tailscale Funnel.

The bootstrap flow:

1. creates hash-only stored MCP and native-agent credentials;
2. seals recoverable local copies with Windows CurrentUser DPAPI;
3. installs a current-user `Nexowire Hub` Scheduled Task bound to `127.0.0.1`;
4. starts the Hub and verifies `/health`;
5. authenticates the generated native-agent credential against the local WebSocket endpoint;
6. installs/repairs the `Nexowire Native Agent` Scheduled Task so the local agent connects over loopback;
7. waits until the Hub reports at least one connected agent;
8. optionally requests auth-gated Tailscale Funnel exposure.

No bearer value is written into the Hub/Agent launcher or lifecycle manifest.

## Status

```powershell
nexowire node status
nexowire hub status
nexowire agent doctor
nexowire tailscale status
```

The node bootstrap is resumable. If Windows restarts or the command is interrupted after protected state is created, rerun the same bootstrap command. Nexowire reuses the DPAPI-protected credentials instead of silently issuing duplicates. Conflicting port, device-name, state-directory, expired, revoked, or inconsistent credential state fails closed.

## ChatGPT connector information

```powershell
nexowire node connector
```

This is intentionally an explicit secret-reveal command. It returns the MCP URL only when Tailscale Funnel is detected as configured and decrypts the MCP bearer token for the current Windows user. Treat that output as a secret.

## Tailscale boundary

The local native agent does not require Funnel. It connects to the Hub through `ws://127.0.0.1:<port>/agent`. Funnel is only an optional public ingress for clients such as a remote ChatGPT MCP connector.

`nexowire tailscale funnel` remains fail-closed unless usable MCP and native-agent authentication already exist. Tailscale is a connectivity aid, not a required Nexowire runtime dependency.

## Completion criteria

A bootstrap is not considered remotely complete merely because the Scheduled Tasks are installed. Final verification requires:

- Hub health succeeds;
- local Agent is authenticated and connected;
- the ChatGPT/Nexowire MCP connection is authenticated;
- `devices_list` shows the stable device online;
- `machine_snapshot` and `machine_health` succeed through MCP.
