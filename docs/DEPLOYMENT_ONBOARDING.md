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

## Operator confirmation before side effects

Status commands are for diagnosis; they do not repair a broken enrollment. `onboard plan` and `doctor --remote` evaluate readiness, but may initialize local credential-state files on first use. For the following steps, the operator should make a deliberate, informed decision **before running the command**:

- `node bootstrap`: creates protected credentials and per-user Scheduled Tasks; `--tailscale-funnel` can additionally request public ingress. Confirm the target Windows account, roots, exposure and interruption impact first.
- `onboard bootstrap`: issues one-time bearer credentials. Confirm the intended scope and an approved secret-storage destination **before** allowing token values to reach terminal output.
- `node connector`: reveals the current MCP bearer token. Run only when the self-host client actually needs that secret; never as a routine health or support check.
- `tailscale funnel`: changes intended network exposure. Confirm the public-ingress decision and authentication prerequisites; do not use it to bypass a failed local health check.
- `onboard bootstrap --force`: rotates/overlaps an otherwise usable credential pair. This needs an explicit owner rotation decision, not an automatic retry.

The written instructions do **not** grant admin/CORE approval, automate elevation or authorize deployment. If the environment or intended user decision is unavailable, keep the operation **NOT_RUN**.

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

## Recover the right flow before retrying

| Observed failure | Safe first step | Do not infer / do |
| --- | --- | --- |
| Hosted Windows page shows **BAĞLANIYOR…** or **TEKRAR DENE** | Follow the [normal Windows pairing guide](INSTALL_WINDOWS.md#3-cihaz%C4%B1-kendi-hesab%C4%B1na-ba%C4%9Fla) under the same GitHub identity; allow the pending attempt to finish and use the documented retry once. | Do not issue self-host credentials, reset the Windows node or paste an OAuth callback into support. |
| Windows self-host Hub/Agent unhealthy or absent | Check `nexowire node status`, then `nexowire hub status` or `nexowire agent doctor` as indicated; preserve existing protected state. | `Running` Scheduled Task or a fresh `onboard bootstrap --force` is not authenticated device health. |
| Self-host local health is good but remote URL is absent or fails | If Funnel was deliberately configured, check `nexowire tailscale status` before any credential reveal; record whether an actual remote MCP client was tried. | Do not paste a loopback address, a guessed HTTPS endpoint or an unverified bearer token into ChatGPT. |
| Manual operator onboarding exits nonzero or readiness is inconclusive | Record the sanitized `onboard plan` / `doctor --remote` result and whether state initialization occurred; classify a failed check as **FAIL** and an unattempted check as **NOT_RUN**. | Do not silently rerun issuance, clear DB/credential state or label a missing observation PASS. |

This is a **decision aid**, not an automatic retry script. Real paired-device and remote MCP health must be verified independently; Windows pairing and manual operator bootstrap are different flows.

## Platform ownership and explicit consent

| Workflow | Who may decide / state changes | Unsupported shortcut |
| --- | --- | --- |
| Normal hosted Windows installation | The user explicitly approves the account pairing in the browser; normal account linkage is not permission to expose a self-host Hub. | Do not require CLI credentials, local Tailscale or an elevation prompt to make **BAĞLA** succeed. |
| Windows self-host `node bootstrap` | The **same Windows user** must approve local Scheduled Tasks and CurrentUser DPAPI credential state; separately approve optional public Funnel exposure. | Do not switch to an Administrator identity to bypass failures, share DPAPI state across accounts or silently add `--tailscale-funnel`. |
| Linux/macOS manual operator `onboard` | The designated operator must approve explicit credential issuance and a supported protected-secret source on that host; the Windows `node bootstrap` path is rejected. | Do not promise per-user Windows Scheduled Tasks/DPAPI or unattended credential writes on Linux/macOS. |

These workflows cannot inherit one another's permissions. A plan/readiness result is not consent, a source-only successful test is not a real installer acceptance, and a missing owner approval means the side-effecting command stays **NOT_RUN**.

For remote deployments, `nexowire doctor --remote` remains the readiness gate. Onboarding does not pretend a loopback/plaintext/missing-TLS deployment is production-ready merely because credentials now exist. Linux/manual hosting requires its own supported, separately verified Agent secret source and lifecycle; the Windows Scheduled Task/DPAPI recipe does not transfer automatically.

Remote readiness still does **not** prove ChatGPT can authenticate, discover the intended device, or call `machine_snapshot` and `machine_health`. Verify those paths with the real client before declaring the connection complete.

## Reporting incomplete evidence

| Report state | Meaning |
| --- | --- |
| Source-only PASS | A local/static assertion ran on the specified commit; not proof of a deployed device or connected ChatGPT client |
| NOT_RUN | A command, Windows host/connector or actual physical scenario was not exercised |
| UNKNOWN | A check ran but the response was absent, inconclusive or lacked a trustworthy measurement |
| Remote acceptance | Requires passing readiness **and** real authenticated client/device health evidence; never inferred from plan/bootstrap output alone |

Treat `action_required`, pending, skipped or an empty CI job list as **not a test PASS**. For #485, clean-user installation, pairing and remote MCP checks still require a real Windows acceptance run. For #539/R17, optional environment-tool inventory cannot substitute for USB, WSL, CUDA or virtual-machine workload execution.
