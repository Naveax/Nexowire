# Deployment Onboarding

This document is for self-hosted/operator deployment. It is not the normal end-user connection flow. Hosted Windows users should follow the [installation and ChatGPT guide](INSTALL_WINDOWS.md), use `nexowire connect` if needed, sign in, and press **BAĞLA**; they do not need to manage tokens, URLs, Tailscale, or capability scopes.

There are **two distinct operator flows**:

- [Windows one-command self-host node](SELF_HOST.md): `nexowire node bootstrap` installs same-user Hub/Agent Scheduled Tasks, uses Windows DPAPI, and optionally requests Tailscale Funnel. This implementation rejects Linux/macOS.
- The `nexowire onboard` flow below: plans deployment readiness or issues credentials for an operator-managed setup. It does **not** install a Hub/Agent, configure TLS/Tailscale, or prove remote connectivity.

For a source checkout, use Node.js 22+ with `npm ci` and `npm run build`; invoke `node dist/src/cli.js` instead of `nexowire` if the CLI is not otherwise on `PATH`. Do not use these developer steps as instructions for first-time hosted Windows users.

The onboarding command creates a safe deployment starting point without writing plaintext bearer tokens into repository files, launcher arguments, or Nexowire state.

## Which operation changes what?

| Operation | Risk category | Expected effect |
| --- | --- | --- |
| `nexowire node status`, `nexowire hub status`, `nexowire agent doctor` | Diagnostic | Inspect local state or probe health; no repair/credential rotation |
| `nexowire onboard plan`, `nexowire doctor --remote` | Readiness (possible local initialization) | Evaluate checks; first run may create credential-state files |
| `nexowire node bootstrap` | Changes local system state | Creates protected credentials, installs/starts per-user Scheduled Tasks |
| `nexowire onboard bootstrap` | Issues credentials | Emits one-time token values to the current terminal output |
| `nexowire node connector` | **Reveals secret** | Decrypts the self-host MCP bearer token; never use for routine diagnostics |
| `nexowire tailscale funnel` | Changes remote exposure | Requests Funnel configuration; requires the auth preconditions |
| `nexowire onboard bootstrap --force` | **Rotates/overlaps credentials** | Issues a new pair even when current credentials work |

Do not run a state-changing, secret-revealing or exposure-changing command to collect a routine support report. See [self-host diagnostic-first recovery](SELF_HOST.md#after-a-disconnection-diagnostic-first-recovery); no `node connector` output is needed for that sequence.

## Plan

```text
nexowire onboard plan
nexowire onboard plan --remote
```

Plan mode does not issue or rotate credentials and runs the deployment-readiness model to explain remaining steps. It may initialize a local credential state directory when first run, so it should not be described as a strict filesystem no-write guarantee.

The following diagnostics report readiness rather than perform deployment:

```text
nexowire doctor
nexowire doctor --remote
```

Nonzero exit status (including code 2 for failed readiness) is not a successful installation. Redact hostnames, credentials and other sensitive diagnostics before sharing a report.

## Bootstrap

```text
nexowire onboard bootstrap
nexowire onboard bootstrap --remote
```

**State-changing operation:** bootstrap issues missing MCP and native-agent credentials through the hash-only credential store. Each plaintext token is returned once in command output and is not persisted by the credential store. Avoid terminal capture/session logs and never copy the output into an issue or chat.

Useful scope options:

```text
--mcp-role user|operator|admin
--mcp-ttl-days N
--agent-ttl-days N
--allow-tool PATTERN
--allow-device STABLE_ID
--allow-route POLICY
```

Repeated bootstrap does not create duplicates while usable credentials already exist. `--force` explicitly creates an overlapping new pair for rotation.

## After bootstrap

Store the one-time native-agent credential through a protected source on the target machine, then configure only its reference in the agent environment.

For the MCP credential, place the one-time token in the ChatGPT/client connector's secret configuration rather than a repository file.

Supported reference names in the operator next-step report include `NEXOWIRE_AGENT_TOKEN_FILE`, `NEXOWIRE_AGENT_TOKEN_DPAPI_FILE`, and `NEXOWIRE_AGENT_TOKEN_PLATFORM_NAME`. These are **references**, not places to paste literal credentials in a README, PR, process argument or public command transcript. Windows self-host bootstrap instead manages its own same-user DPAPI protected copies; do not combine these two credential recipes casually. On Linux, confirm that the selected protected secret source and permissions really work; macOS protected-store read/status support does not imply unattended write support. Do not share real one-time token output in support requests.

If a first-run attempt is interrupted, inspect readiness and existing credential state before considering another issuance. `--force` is a rotation decision, not a connectivity troubleshooting flag.

For remote deployments, `nexowire doctor --remote` remains the readiness gate. Onboarding does not pretend a loopback/plaintext/missing-TLS deployment is production-ready merely because credentials now exist. Linux/manual hosting requires its own supported, separately verified Agent secret source and lifecycle; the Windows Scheduled Task/DPAPI recipe does not transfer automatically.

Remote readiness still does **not** prove ChatGPT can authenticate, discover the intended device, or call `machine_snapshot` and `machine_health`. Verify those paths with the real client before declaring the connection complete.
