# Hub runtime identity and production cutover acceptance

Hub v1.0.5 source is built and can start side by side with the legacy v1.0.0 Stack Hub. A successful isolated `/health` alone **does not** prove the active production Hub has been upgraded.

## New additive response

`GET /health` preserves `ok`, `service`, `transport`, `agents` and `time` unchanged and adds:

```json
{
  "runtime": {
    "packageVersion": "1.0.5",
    "mcpRouterSha256": "<sha256 of the actual loaded create-server.js>",
    "ownerAutoRoutingContract": "owner-auto-v1",
    "ownerOauthConfigured": false
  }
}
```

The SHA-256 value is calculated **once when the Hub starts** using the actual MCP router module bytes loaded alongside its HTTP server module. It is not derived from a filename, Git remote name, editable label or release-asset URL. The typecheck/test harness uses the source `.ts` pair; a deployed Node.js build uses the compiled `.js` pair. No credentials, tokens, file paths, account names, device IDs or sensitive configuration are exposed. `ownerOauthConfigured: true` means only that a hosted remote OAuth verifier is configured; **it is not proof of successful OAuth authentication or user permission**.

Old v1.0.0 hubs do not emit the `runtime` field. A staged v1.0.5 Hub will emit `ownerAutoRoutingContract: owner-auto-v1` whether or not the owner OAuth is configured, making support distinguishable from activation.

## Legacy supervisor conflict check

Before attempting to register **any** new Hub Scheduled Task, run the read-only CLI:

```powershell
nexowire hub preflight
```

It reports `legacyStackTaskState`, `standaloneHubLifecycleBlocked` and `mode: inspection-only`. If the old `Nexowire Stack` Scheduled Task is `Running`, the CLI **refuses** `hub install`, `hub start`, `hub restart` and elevated `hub boot-install` before creating or modifying a task or protected secret. The old supervisor uses a fixed v1.0.0 CLI path and will respawn its own Hub if that mode exits; adding an independent Hub task on the same port is an unsafe competing lifecycle.

`standaloneHubLifecycleBlocked: false` does **not** authorize deployment: it only says this specific old Stack task was not reported as running. It is not an assertion that port 43110 is free, a different supervisor is absent, or owner OAuth/rollback have been accepted. Full owner-approved coordinated migration and verification remain necessary. Existing Hub `stop`/`uninstall` cleanup commands are not gated by the old supervisor guard, so erroneous extra tasks can still be removed.

## Required production gates

1. **Stage and fingerprint** the release in an approved, admin-protected install path; compare `mcpRouterSha256` to the hash of the *same verified staged compiled file*.
2. Preserve the legacy Hub launch identity, OAuth/agent service credentials, unmodified Stack supervision script and an independent rollback. The Stack v1.0.0 supervisor respawns its old Hub when no matching `http` mode process exists. Therefore, killing PID 8324 directly is not an approved migration method.
3. Owner-authorize a coordinated Hub supervisor handoff; do not restart, kill, or reparent durable workers or the separate Broker. Stage in a user-writable directory only for smoke testing, **never** as an elevated executable source.
4. Verify the production `43110/health` response has **both** the exact expected compiled router SHA-256 and routing contract `owner-auto-v1`, `ownerOauthConfigured:true`, and the correct Agent count. A supported binary is not evidence of authenticated owner access.
5. With the real owner's signed-in OAuth account, separately test AUTO disabled (including sole device), enabled (sole registered online device), multiple devices including offline device, empty/duplicate folders, explicit names, cross-account isolation, immediate AUTO revoke on the next MCP POST, and unaffected SAFE/FULL privileges.
6. Verify the old and new Hub never run on the same port, all Agent sessions return to online and the current durable-workload inventory is preserved. Roll back the Hub if any gate fails.

For current status see Issue #265 (owner-bound AUTO Hub rollout). The unrelated protected Broker / ROOT defect remains Issue #260.
