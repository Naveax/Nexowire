# Admin Bridge UI: truthful preference and runtime status

A saved ON/OFF/AUTO preference is **not** evidence of a successfully started or stopped Windows Broker. After PR #341 introduced convenient one-click toggles, this change prevents a dangerous UI misinterpretation:

- Device telemetry `adminBridgeReady=true` and `privilegeMode=broker` is treated as a **Broker readiness report only while the device is online**. Last-known Broker data from an offline device cannot be called live.
- **OFF + ready report** explicitly warns that the Broker still reports ready and no actual stop occurred. OFF + no ready report is **not** proof of a stopped task.
- **ON + missing readiness** explicitly says the Broker is not ready and a start command was not sent.
- **AUTO** explicitly says automated local task management is not yet connected.
- All states disclose that the toggle saves a preference but does not yet actuate a Windows Scheduled Task; OFF also revokes CORE, as established by the owner API.
- Card-chip, live state label and diagnostics use the terms “reported” / “unverified” rather than claiming that remote privilege was measured by an independent protected local service.

The source-only UI continues to call the existing owner-authenticated `bridge-preference-v1` endpoint. It does not call `/bridge-command` or enable the disabled command transport. New regression tests ensure offline telemetry cannot be promoted to live readiness and the ON/OFF/AUTO mismatch warnings remain present.

## Remaining production gates

P0 #271 elevated Stack source ACL is still open. An independent protected Guardian, per-device signed receipt enrollment, authenticated transport, replay-safe local command channel and an owner-approved maintenance cutover must be accepted before a UI toggle may genuinely manipulate a privileged task. Neither a green CI run nor a positive Broker telemetry field satisfies these conditions. Production Worker and live Windows tasks are unchanged.
