# Nexowire Privileged Broker v1.0.0/v1.0.5 compatibility preflight

## Live evidence: 2026-10-08

Do not confuse the 15-minute **ROOT MODE** server lease with verified Windows elevated permissions.

| Probe | Naveax | work-pc |
| --- | --- | --- |
| Native Agent | v1.0.5, online | v1.0.5, online |
| Agent requested mode | `broker` | `broker` |
| Broker URL | `http://127.0.0.1:43112` | Same |
| Port listening | Yes | Yes |
| Unauthenticated `GET /health` | HTTP 404, `NOT_FOUND` | HTTP 401, `UNAUTHORIZED` |
| Unauthenticated `GET /execute` | HTTP 404, `NOT_FOUND` | HTTP 401, `UNAUTHORIZED` |
| Legacy Stack package | **v1.0.0** | Not installed at legacy location |
| Legacy Stack Broker code | Only `/execute`; **no `/health`** | Current Broker understands `/health` |
| Broker task | Ready, last result 1 | Running |
| Stack task | Running (Highest) | Not used |

The v1.0.5 Native Agent calls `PrivilegedBrokerClient.probe()` against authenticated `GET /health`. It reports `adminBridgeReady=true` **only when** `privilegeMode='broker'`, `reachable=true`, and `elevated=true`. The legacy Stack's port listener is therefore **not compatible**. This is the verified primary root cause of Naveax's Bridge-ready failure. The separate scheduled task's exit code 1 may be caused by port contention; inspect task logs with authorized elevated access before concluding.

## Safe read-only diagnostic

Run under any authorized local user:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\diagnose-broker-compat.ps1
```

The tool reports JSON and never reads Bearer tokens or protected launchers, performs elevated mutation, or restarts software. Classification `ROUTE_COMPATIBLE_AUTH_REQUIRED` means **only** that the HTTP route exists. It deliberately does not infer elevation, correct secrets, or owner OAuth readiness.

### Protected switchover acceptance (not yet performed)

1. Confirm the standalone `Nexowire Privileged Broker` task's actual command and integrity from an authorized elevated session. The protected ProgramData launch folder cannot be read by limited user; treat access denial as **unknown**, not missing.
2. Inspect its Task Scheduler last-run error and 43112 listener ownership. Validate the task points at **v1.0.5** code and uses the protected secret source shared with the v1.0.5 Native Agent. Do not display token bytes.
3. Stage a verified **side-by-side** v1.0.5 Broker, matching OS architecture and signed package/hash. Do not edit the currently running `Nexowire Stack` script, Hub, or Agent.
4. In an owner-authorized maintenance interval, retire **only** the legacy **Broker** listener; then start exactly one protected Highest-mode v1.0.5 Broker on 43112. Use controlled Windows task authorization. Do not kill the Hub's process tree or durable workers. If this isolated operation cannot be guaranteed, leave the existing listener unchanged.
5. Check unauthenticated `GET /health` is **401**, then **authenticated** Broker probe: `reachable=true`, `elevated=true`, `version='1.0.5'`. Never substitute HTTP 401 alone for a real privileged probe.
6. Ensure Native Agent v1.0.5 advertises fresh `adminBridgeReady=true` via a controlled hello/reconnect; the existing implementation probes on hello, so a Broker replacement may not automatically update a still-open agent session.
7. As signed-in owner, enable and revoke the 15-minute ROOT lease, verify TTL and audit, and test one harmless approved elevated operation. Confirm both devices online, Native Agent updates intact and durable workers alive. Roll back **only the isolated Broker** on any failed check.

No staged-recovery or live switchover is claimed in this document. The read-only preflight has been executed successfully on Naveax and work-pc.

Tracking: GitHub Issue #260.
