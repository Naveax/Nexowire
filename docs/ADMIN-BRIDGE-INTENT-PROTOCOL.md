# Admin Bridge intent and acknowledgement contract (v1)

This is a schema and **pure validation** component, not a working remote control channel. No operating-system task commands are executed.

## Intent envelope
`AdminBridgeModeIntentSchema` accepts exactly a versioned, single-device `admin-bridge.mode-intent` with a UUID request ID, owner ID, device ID, current pairing's SHA-256 credential binding, desired mode AUTO/ON/OFF and issuance/expiry timestamps. Validation rejects wrong identity, stale/re-paired credential binding, already consumed IDs, future issuance outside 5 seconds and intents exceeding 120 seconds lifetime.

**Security assumptions still required for integration:** transport authentication with credential/session binding, authorization by the actual device owner, server-generated signed or MAC-protected payload, a durable atomic consume/claim operation, explicit short-lived user confirmation, and verified local interactive elevated execution context. A caller-supplied `hasConsumedRequestId` callback alone is insufficient to guarantee exactly once in a distributed system. A SHA-256 credential binding is **not** a signature and must never be treated as one.

## Receipt envelope
`AdminBridgeModeReceiptSchema` accepts only an exact matching request UUID/device/pairing/mode, timestamp within the permitted window, task state and Broker health evidence.

A receipt may indicate `applied` only if:
- OFF: Windows Task Scheduler reports Disabled **and** independent Broker probing confirms the listener absent.
- ON/AUTO: task is Running **and** the expected Broker responds to an authenticated health probe.
- Both: the task status check itself was verified, the receipt is fresh, and there is no reported failure code.

A failed operation must carry a bounded failure code and stays `applied:false`, regardless of task status.

**Operational gaps:** Trusted device-side producer of a receipt and its authentication, replay ledger, durable cloud storage and UI status propagation are still pending in #323. These must not be inferred from the existing `device_bridge_preferences` preference row. In particular, never automatically replay preexisting OFF/ON preferences as privileged commands after deployment, and do not claim the source-only local reconciler in #327 is active on a live Agent.

Live privileged runtime cutover remains subject to #271 acceptance. The control plane may display desired policy without implying actual machine state.
