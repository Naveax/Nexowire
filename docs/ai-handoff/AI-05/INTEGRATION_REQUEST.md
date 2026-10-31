# AI-05 Cross-owner integration requests

These are requests only, not permission to modify another agent's files.

## AI-04 Broker admission / #947 immutable callback contract
The protected Broker fence must provide a detached and deeply immutable approved request matching the same original UUID, capability, fingerprint and owner/device/session/generation scope used during independent CAS. The Broker must independently verify actual payload bytes and current owner/revoke/privilege/receipt before each effect; a transport success, duplicate UUID or signed JSON alone must not be an execution permit. Keep signed receipt canonicalization in AI-04-owned modules.

## Coordinator `src/agent/native-agent.ts` and journal
Only the coordinator may wire real approved dispatch/grant scope to the executor. Preserve the release's WAL/restart safeguards, immutable logical mutation ID, terminal UNKNOWN and no blind retry. If `created:false`, callback dispatch is prohibited until independent reconciliation. Do not enable CORE by configuration in this source PR.

## AI-07 OS sandbox
Shell/task graph/process effects need a separate real low-privilege provider and OS readback; a CAS reservation must never be interpreted as a shell launcher grant. The AI-07 handoff from #990 is tracked but not implemented here.

All physical integration requires separately authenticated and authorized owner/device Windows readback. This PR is not release approval.
