# Native Agent Lifecycle

Nexowire can manage its own native-agent autostart without Remote Desktop Commander, SentinelX, or another runtime provider.

## Commands

```text
nexowire agent run
nexowire agent install
nexowire agent status
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

## Linux

Linux uses a systemd user service with `Restart=always` and `WantedBy=default.target`.

Whether a user service remains alive with no login session depends on the host's systemd-logind linger policy. Nexowire does not silently enable linger because that changes host account lifecycle policy.

## macOS

The lifecycle command currently fails closed on macOS. Keychain reads are supported elsewhere in Nexowire, but LaunchAgent lifecycle will not be declared complete until its install/control path is covered without weakening secret handling.
