# Self-hosted Nexowire node

This is an **operator/developer** path, not the normal hosted connection flow. If you just want to connect a Windows PC to your Nexowire account and ChatGPT, follow the [normal Windows installation guide](INSTALL_WINDOWS.md) instead. That route uses the hosted service and OAuth; it does **not** ask you to create a self-hosted bearer token, configure Tailscale, or expose a port.

A self-hosted node runs the Nexowire Hub and local Native Agent under the **same Windows user account**. The Hub stays bound to `127.0.0.1`. Optional Tailscale Funnel can expose the authenticated MCP endpoint over HTTPS without opening a router port; it does not replace MCP authentication.

## Preconditions and boundaries

1. The `nexowire node bootstrap` implementation currently **requires Windows**. It installs per-user Windows Scheduled Tasks and protects local credentials with Windows CurrentUser DPAPI. It explicitly rejects non-Windows platforms; do not apply this bootstrap recipe to Linux/macOS.
2. Run under the Windows account that will own the Hub, Agent and protected credentials. Do not elevate or switch accounts merely to bypass a permission error.
3. Have a working Nexowire CLI. If using the **source/developer** checkout, the project requires Node.js **22+** (see `../package.json`); from the repository root run `npm ci` and `npm run build`, then use `node dist/src/cli.js` in place of `nexowire` in the examples. These source-build steps are **not** required for the [normal published Windows installer](INSTALL_WINDOWS.md).
4. Decide which folders the Agent may access. The omitted `--allow-root` default is the Windows user's home directory; use explicit, minimal roots where appropriate. No bootstrap result proves a privileged/CORE capability is authorized.
5. **Only if requesting `--tailscale-funnel`:** have Tailscale installed, signed in, and eligible/configured to use Funnel. Without Funnel, the local Hub/Agent path is still valid, but a remote ChatGPT connector URL is **not** established. Do not expose the loopback Hub directly to the Internet or weaken auth to make it reachable.

For a separate deployment plan (including non-Windows/manual operator paths), see [Deployment Onboarding](DEPLOYMENT_ONBOARDING.md). That planning flow is **not** the Windows one-command node bootstrap.

## Choose the right address (do not guess an endpoint)

| Situation | Address source | Authentication | Boundary |
| --- | --- | --- | --- |
| Normal hosted Windows/ChatGPT user | The official hosted service's advertised MCP `resource` URL, as explained in the [Windows guide](INSTALL_WINDOWS.md#chatgpt-adresini-bulma) | Hosted OAuth | Do **not** enter the login/control-panel URL or add `/mcp` by guessing. |
| Self-host Hub on the same PC | `http://127.0.0.1:<port>/mcp` | Local MCP credential | Loopback is **not** a remotely accessible ChatGPT connector URL. |
| Self-host with verified Funnel | `https://<tailscale-dns-name>/mcp` returned by `nexowire node connector` | Self-host MCP bearer credential | Only use when Funnel is actually configured; the command reveals a secret. |

Do not replace a hosted OAuth connector with a localhost URL, and do not paste a self-host bearer token into the hosted OAuth form. A successfully running local task is not proof of remote MCP reachability.

### Connector address examples (source and trust boundary)

| Candidate entered into a remote client | Verdict / action |
| --- | --- |
| `http://127.0.0.1:<port>/mcp` or `http://localhost:<port>/mcp` | **Reject for remote ChatGPT**: these names refer to the client's own loopback, not the user's Windows Hub. |
| `https://<tailscale-dns-name>/mcp` | **Conditionally valid self-host URL** only when it is the actual non-null `mcpUrl` returned by the owner's `node connector` after an approved, working Funnel configuration. A plausible HTTPS hostname alone proves nothing. |
| Hosted control-panel/login page | **Reject as MCP server URL**. Fetch the actual published OAuth protected-resource metadata through the official Windows guide; never append `/mcp` by guessing. |
| `https://unknown.example/mcp` suggested in a chat or error message | **Reject as unverified**. Do not send credentials to a hostname chosen by an unauthenticated message. |

The `node connector` response contains a bearer credential and must never be attached to a help ticket or test fixture. If `mcpUrl` is null or the remote client fails authentication, keep the remote connection **NOT_RUN/FAILED as actually observed**; do not substitute an arbitrary URL or reveal the token to troubleshoot.

## Platform support: documented code paths, not runtime certification

| Host platform | Normal published installer | `node bootstrap` | Manual operator `onboard` |
| --- | --- | --- | --- |
| Windows 10/11 x64 | [Published end-user route](INSTALL_WINDOWS.md) | Windows-only implementation using CurrentUser DPAPI and Scheduled Tasks | CLI plan/bootstrap code exists; environment readiness still required |
| Linux | Windows installer **not applicable** | **Rejected by source guard** | Plan/doctor code paths exist, but Linux deployment is **not verified** here |
| macOS | Windows installer **not applicable** | **Rejected by source guard** | Plan/doctor code paths exist, but macOS deployment is **not verified** here |

The matrix describes the current source interface, not a tested distribution or a blanket platform-support promise. Node 22+ and the build commands above apply to developer checkouts; they do not make the Windows installer portable.

### Core setup versus optional environment tools

| Path | Required for that path | Optional / separate preflight |
| --- | --- | --- |
| Hosted Windows end user | Published Windows installer and account connection from the [normal guide](INSTALL_WINDOWS.md) | No source checkout, Node/npm, Tailscale, WSL, CUDA or Ollama prerequisite |
| Windows self-host node | Nexowire CLI, same-user Windows Scheduled Tasks and CurrentUser DPAPI | Tailscale **only** if requesting Funnel; no USB/GPU/WSL/Hyper-V dependency for ordinary Hub/Agent bootstrap |
| Developer source checkout | Node.js 22+, `npm ci`, `npm run build` | Workload-specific Python, WSL, USB, CUDA, Ollama, Hyper-V, Docker or GPU tools are not baseline dependencies |
| Environment Doctor for #539/R17 | Explicitly selected read-only checks in [Environment Doctor](environment-doctor.md) | Missing optional tools are warnings unless the operator explicitly requires them; an inventory check is not physical acceptance |

These optional tools are **not automatically installed** or enabled by either onboarding flow. A Driver/USB/CUDA/WSL check can report an observation or insufficient evidence; it cannot prove that the original workload or physical device works.

For a **developer source checkout only**, an opt-in read-only Environment Doctor example is:

```powershell
node --import tsx scripts/run-environment-doctor.ts --tool=node:22
```

This is **not** a `nexowire node` subcommand or a requirement for the published Windows installer. It checks the selected Node runtime without installing tools. Only add workload-specific `--require-wsl`, `--require-cuda`, `--require-hyperv`, `--usb-vid-pid=VID:PID`, `--tool=NAME:VERSION` or `--python-package=NAME:VERSION` when the *actual workload* requires them. An unavailable optional tool without a requirement is a warning; a missing **requested** capability is a failed readiness check, not proof that its hardware cannot work. Cross-platform or injected synthetic observations remain **NOT_TESTED** for physical USB, phone, gamepad or VM acceptance.

## One-command Windows bootstrap (changes local state)

```powershell
nexowire node bootstrap --device-name work-pc
```

This first example starts the **local** Windows Hub/Agent route only. It does **not** produce a remotely usable ChatGPT connector. If the operator explicitly decides to expose authenticated MCP through Funnel **and** has verified all Tailscale requirements above, `--tailscale-funnel` may be added to the bootstrap invocation:

```powershell
nexowire node bootstrap --device-name work-pc --tailscale-funnel
```

Do not add Funnel merely to make a failing local health check disappear. Either bootstrap command is state-changing; get the owner's informed approval before running it.

Optional flags (do not put tokens into arguments):

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

## Diagnosis without credential reveal

```powershell
nexowire node status
nexowire hub status
nexowire agent doctor
nexowire tailscale status
```

These are status/diagnostic paths, not a remote-connection acceptance test. Start with `nexowire node status`; inspect `health`, `healthError`, Agent status, and `tailscale` fields. If the Hub or Agent is not healthy, record the sanitized error and reconcile the existing task/state before retrying bootstrap. Do not delete `.nexowire` state, credential files, or journal data to clear an error.

### After a disconnection: diagnostic-first recovery

1. Check `nexowire node status` for Hub health and reported Agent connection state.
2. If the Hub is unhealthy, inspect `nexowire hub status`; if Hub is healthy but Agent absent, inspect `nexowire agent doctor`. A reported task `Running` is not an authenticated Agent connection.
3. Only for a remote-Funnel complaint, inspect `nexowire tailscale status`. If Funnel is absent, record it as an unresolved remote ingress rather than guessing a public URL.
4. Preserve the sanitized diagnostic result and the existing protected state; escalate unexpected auth, credential, DB or WAL errors. Do not issue new credentials, clear state or run a service reinstall as a diagnostic shortcut.

These commands are non-repairing status/diagnostic operations. They may probe local services; they do not establish a physical acceptance result. `nexowire node connector` is **not** part of this diagnostic sequence because it reveals a bearer token.

### A safe support report after a failed local connection

Record only the **category** of the failing step (`Hub health`, `Agent connection`, `Funnel ingress`, or `remote MCP authentication`), the exit/status code when actually observed, and a sanitized diagnostic summary. Replace tokens, callback query parameters, cookie values, device identifiers, private paths and full URLs with `[REDACTED]` before sharing. A password, bearer credential, signed callback or raw `node connector` output must never appear in a support ticket. If the relevant observation was not collected, use **NOT_RUN**, not a fabricated healthy value; if a probe ran without an interpretable answer, use **UNKNOWN**.

For an interrupted attempt: first inspect existing `node status`, then follow the failed layer. Retry only the already-approved operation after its prerequisites are understood; a new `onboard bootstrap --force` rotates credentials and is not a pairing recovery step. Do not delete state, rerun with another Windows account, reinstall, or disable authentication to turn a failed diagnostic green. If actual remote MCP authentication fails, capture only a redacted status/error classification and request the appropriate owner's investigation.

The node bootstrap is resumable. If Windows restarts or the command is interrupted after protected state is created, rerun the same bootstrap command. Nexowire reuses the DPAPI-protected credentials instead of silently issuing duplicates. Conflicting port, device-name, state-directory, expired, revoked, or inconsistent credential state fails closed.

## ChatGPT connector information

```powershell
nexowire node connector
```

**Warning:** this is an explicit secret-reveal command, not a status check. It decrypts the MCP bearer token for the current Windows user; its `mcpUrl` may be `null` if Funnel is unavailable. Treat the entire output as sensitive: do not paste it into chats, issues, logs or screenshots. A self-hosted bearer-token setup is distinct from the hosted-service OAuth connection described in the normal Windows guide.

Protected local token files belong to the Windows user account that created them. Do not copy protected data to another account or machine and assume it can be decrypted there. Never use a plaintext token in shell history, command-line arguments, repository fixtures or environment-variable examples; only configure a reference to an approved protected source. See [operator credential handling](DEPLOYMENT_ONBOARDING.md#after-bootstrap).

## Tailscale boundary

The local native agent does not require Funnel. It connects to the Hub through `ws://127.0.0.1:<port>/agent`. Funnel is only an optional public ingress for clients such as a remote ChatGPT MCP connector.

`nexowire tailscale funnel` remains fail-closed unless usable MCP and native-agent authentication already exist. Tailscale is a connectivity aid, not a required Nexowire runtime dependency.

## Completion criteria

### Do not collapse browser, task and remote evidence

| Observation | What it can establish | What it cannot establish |
| --- | --- | --- |
| Windows installer finished / Start menu shortcut exists | Local installation step may have completed | No proof of healthy Hub/Agent or account pairing |
| Windows Scheduled Task says `Running` | A launcher/task may be active | No proof the Hub is healthy or the Agent authenticated |
| `node status` reports local Hub health | Local Hub responded to a status probe | No proof the browser's **BAĞLA** approval, account identity or remote MCP call succeeded |
| Browser shows **BAĞLANIYOR…**, **TEKRAR DENE** or a successful pairing message | Browser-side pairing state was rendered | No proof of self-host Funnel, native Agent health or authenticated remote MCP execution |
| Remote client reports MCP connected | The remote connector handshake may have succeeded | No proof that `devices_list`, `machine_snapshot` and `machine_health` passed against the intended device |

Treat missing evidence as **NOT_RUN** and an attempted but inconclusive observation as **UNKNOWN**, never as an implicit successful connection. Require the actual per-layer checks below before saying *connected*.

A bootstrap is not considered remotely complete merely because the Scheduled Tasks are installed. Final verification requires:

- Hub health succeeds;
- local Agent is authenticated and connected;
- the ChatGPT/Nexowire MCP connection is authenticated;
- `devices_list` shows the stable device online;
- `machine_snapshot` and `machine_health` succeed through MCP.

These checks require an actual Windows host and remote client; source-only tests or a Scheduled Task's `Running` state do not satisfy them.

For evidence, distinguish an offline source check (which may pass), **NOT_RUN** (no eligible Windows host/real connector), and **UNKNOWN** (a relevant observation is missing or inconclusive). Do not translate a synthetic fixture, `action_required` CI, or an unobserved physical check into a passed self-host acceptance result.
