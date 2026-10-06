# Native Agent Lifecycle

Nexowire can manage its own native-agent autostart without Remote Desktop Commander, SentinelX, or another runtime provider.

## Commands

```text
nexowire agent run
nexowire agent enroll --hub-url <ws://loopback/agent|wss://remote/agent>
nexowire agent doctor
nexowire agent status
nexowire agent install
nexowire agent start
nexowire agent stop
nexowire agent restart
nexowire agent uninstall
```

Running `nexowire agent` without a subcommand remains equivalent to `agent run`.

## Secret safety

The installer deliberately refuses to persist plaintext values from:

- `NEXOWIRE_AGENT_TOKEN`
- `NEXOWIRE_AGENT_TOKENS`
- `NEXOWIRE_PRIVILEGED_BROKER_TOKEN`
- `NEXOWIRE_PRIVILEGED_BROKER_TOKENS`

Configure a protected secret reference first, such as:

- Windows DPAPI: `NEXOWIRE_AGENT_TOKEN_DPAPI_FILE`
- permission-restricted mounted file: `NEXOWIRE_AGENT_TOKEN_FILE`
- platform secret store item: `NEXOWIRE_AGENT_TOKEN_PLATFORM_NAME`

The lifecycle launcher may persist the reference/path and non-secret connection configuration, never the bearer token itself.

## Windows

Windows uses a current-user Scheduled Task triggered at logon with automatic restart settings. This is intentional: GUI, UI Automation, screenshots, keyboard, and pointer control need the interactive user session rather than Session 0.

A logout ends that interactive session. The agent starts again at the next logon; it is not disguised as a LocalSystem service.

The Windows native agent also acquires a kernel-owned, device/user-scoped named-pipe singleton lease before opening persistent worker/task state or Hub connections. If two historical launchers try to start the same device identity, the second exits with `AGENT_ALREADY_RUNNING`; it must not connect as a duplicate. The kernel releases the lease after normal exit or forced termination, so no stale PID/lockfile reset or credential is needed. Keep launcher ownership unambiguous instead of treating the singleton as a substitute for correct Scheduled Task registration.

## Linux

Linux uses a systemd user service with `Restart=always` and `WantedBy=default.target`.

Whether a user service remains alive with no login session depends on the host's systemd-logind linger policy. Nexowire does not silently enable linger because that changes host account lifecycle policy.

## macOS

macOS uses a per-user LaunchAgent under `~/Library/LaunchAgents`.

- `RunAtLoad` and `KeepAlive` provide login-start and restart behavior.
- `stop` unloads the job for the current login session while keeping the plist installed.
- `start` bootstraps the installed plist again.
- `restart` performs an explicit bootout/bootstrap cycle.
- `uninstall` unloads the job and removes the plist plus Nexowire lifecycle files.
- The plist contains only `/bin/sh` plus the Nexowire launcher path. It does not contain bearer credentials.

Use `NEXOWIRE_AGENT_TOKEN_PLATFORM_NAME` to reference an existing Keychain item or another protected-secret reference. Nexowire still keeps macOS Keychain write/update fail-closed until a no-argv/no-log storage mechanism is proven; lifecycle support does not weaken that rule.


## Enrollment and connection truth

`agent status` reports lifecycle state separately from Hub connectivity. An installed Windows Scheduled Task in `ready` state is only configured, not proof that the agent is online.

`agent doctor` validates the persisted Hub endpoint, protected credential reference, WebSocket authentication, Tailscale availability, and the local stable device identity. Final enrollment still requires MCP-side verification with `devices_list`, `machine_snapshot`, and `machine_health`.

`agent enroll` rejects bearer tokens in argv. On Windows it reads the token from hidden TTY input or stdin, seals it with CurrentUser DPAPI, persists only the protected-file reference, validates the Hub endpoint, and probes authentication before persisting the lifecycle.

## Tailscale-assisted setup

`nexowire tailscale status` reports Tailscale connectivity and MagicDNS identity.

`nexowire tailscale serve` proxies the local Nexowire Hub through Tailscale Serve for tailnet-only access.

`nexowire tailscale funnel` exposes the local Hub through Tailscale Funnel for Internet-facing ChatGPT/MCP access. Nexowire refuses to configure Funnel unless both MCP and native-agent authentication are already available.

`nexowire tailscale reset serve` and `nexowire tailscale reset funnel` remove the corresponding exposure.
