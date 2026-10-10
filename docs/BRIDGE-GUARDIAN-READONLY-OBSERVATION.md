# Bridge Guardian read-only observation boundary

PR #336 introduced a **read-only, redacted** Windows Task Scheduler inventory. This module adds a **strict Node-side parser** and safe classification for that report.

`assessBridgeGuardianReadOnlyInventory(text,{expectedUserSid})`:

- Refuses empty, malformed, over-64 KiB, unknown-field, wrong-user and internally inconsistent reports; requires `auditOnly=true` and `privilegedOperationPerformed=false`.
- Differentiates verified absence, inability to inspect, untrusted task identity, task identity only and identity plus guarded source ACL.
- Verifies `SNAPSHOT_ONLY` against the exact expected task, single pinned action, Highest/Interactive owner SID and logon trigger in `verifyBridgeGuardianTaskSnapshot`.
- For matching task identity, **separately** calls read-only `verifyBridgeGuardianSourceAcl`; missing/unsafe source remains `task-identity-only`.
- Regardless of status, returns `hubChannelVerified:false` and `remoteActuationAuthorized:false`. The caller must **never** cast or convert this diagnostic report to `BridgeGuardianTrustedFacts` for privileged command authorization.

## Local work-pc evidence, 2026-10-10

Running the shipped read-only inventory script on the development `work-pc` returned:

```json
{"auditOnly":true,"privilegedOperationPerformed":false,"installed":false,"lookupVerified":false,"status":"UNVERIFIED","snapshotPresent":false}
```

**UNVERIFIED does not mean ABSENT.** The exact-name task query returned an error and the inspector correctly refused to infer absence or trust. No task registrations, permissions, processes or secrets were changed.

## Limitations

A task's metadata, self-reported health and a clean source path alone cannot prove active elevated authority or authenticated Guardian ↔ Hub transport. A JSON report can be spoofed if passed by an untrusted caller. No authenticated collector, service installation, credential storage, durable local replay database, actual privileged Broker actions, signature/publisher validation or production cutover is implemented. P0 #271 remains open. All tests are non-mutating and the production Worker remains in default-disabled Bridge command mode.
