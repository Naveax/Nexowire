# FULL mode and Windows UAC handling

FULL mode is **not** permission to disable Windows UAC or automatically click \`consent.exe\` on the Secure Desktop. Windows intentionally separates those prompts from ordinary interactive processes. Nexowire does not silently modify UAC registry security policy, impersonate Secure Desktop, or provide a raw elevated arbitrary-command proxy.

## Implemented behavior

- \`windows_uac_status\` is a **read-only** Nexowire MCP operation: inspects the presence of \`consent.exe\` for the agent's current Windows session, determines FULL vs SAFE mode, probes the existing privileged Broker, and returns a grounded recommended action. If process enumeration is blocked the answer is **unknown**, never optimistic "no prompt". A process existing is evidence of a possible pending consent; it is not a claim to be able to read or press its Secure Desktop buttons.
- \`windows_installer_apply\`, under **FULL** mode, allows one exact installation job only after an administrator previously provisioned a machine-protected approval record with matching SHA-256, exact ordered arguments, publisher/signing policy, and executable restriction. The agent forwards that job to an already elevated, previously authorized Broker; it does not spawn a new UAC prompt or click an existing one. When the Broker is unavailable, the action is rejected.
- \`windows_installer_status\` reads the queued/running/succeeded/failed result of that authorized job. A queued job is **not** a completed installation.
- SAFE mode must not gain installer launch permission. Any existing unapproved \`consent.exe\` dialog remains the operating system's responsibility and can require a local human decision.

## Expected operator workflow

1. Inspect \`windows_uac_status\` when an installer seems blocked.
2. In FULL mode with a reachable elevated Broker, if the device administrator had approved that **exact** installer and arguments, start a new \`windows_installer_apply\` job without prompting the OS again. Do not automatically replay a pending or already-running installation.
3. Follow \`windows_installer_status\`; report completion only after exit/status verification.
4. If no approval exists, the existing Secure Desktop prompt cannot be approved by this capability. An authorized person decides locally whether and how to approve or provision a narrow future approval.

\`consent.exe\` shown in the earlier screenshot is an example, not current proof the dialog is still open. On 2026-10-08 the existing work-pc v1.0.4 read-only inspection returned **zero** current-session consent processes, and the loopback elevated Broker task was Running on 43112. This does not mean UAC is disabled.

## Acceptance gates

Source feature still needs focused Windows, CI, release and deployed acceptance. **Neither** this read-only UAC inspection nor the existing signed/approved Broker execution removes the operating system's UAC protection. Source changes are not active on the installed v1.0.4/v1.0.3 agents until the next authorized release and rollout. Pre-login SYSTEM Hub and authenticated production load/recovery gates remain open.


## Installer preflight (added after initial UAC status support)

Before trying to run a *new* installer, FULL mode can invoke `windows_installer_preflight` with exactly the same file SHA-256, arguments and signing requirements as `windows_installer_apply`. The already elevated Broker verifies the actual file bytes and checks the administrator-owned machine approval. The result is `ready`, `not_approved`, `invalid_input` or `invalid_source`; this **does not execute** the installer or make a UAC dialog disappear. Only a `ready` result should lead to a subsequent `windows_installer_apply` request with those same pinned inputs. The execution path independently revalidates all conditions and checks the protected staged payload. SAFE mode cannot use preflight to infer or extend elevated permissions.
