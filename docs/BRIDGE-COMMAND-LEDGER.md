# Admin Bridge durable command ledger (pre-transport)

Migration `0016_device_bridge_commands.sql` introduces a **dormant** D1 table of bounded, pairing-bound command intents. No existing `device_bridge_preferences` rows become executable commands, and no new public endpoint, Worker dispatch, Windows task mutation or automatic mode processing is added by this change.

A ledger row contains the unique request UUID, device/owner IDs, current pairing credential SHA-256 hash, AUTO/ON/OFF mode, canonical UTC millisecond issue/expiry, status (`queued`, `claimed`, `applied`, `failed`), and timestamps/failure code. Lifetime is greater than zero and at most 120 seconds.

Store operations (identical D1 and memory contracts):
- `queueBridgeCommand`: guarded atomic `INSERT ... SELECT` from the **current** device owner and credential. The request UUID is unique and collisions are not overwritten.
- `claimBridgeCommand`: guarded atomic `UPDATE ... WHERE status='queued'` allowing **one successful claim** at or after issuance and strictly before expiry. A re-paired credential or wrong device cannot claim.
- `completeBridgeCommand`: guarded atomic `UPDATE ... WHERE status='claimed'` allowing **one successful result** only before expiry and after claiming with the same current device credential. Success has no failure code; failures require a bounded machine-readable failure code.
- `getBridgeCommand`: internal store lookup; exposing it to HTTP callers needs separate authentication/authorization.

The database state transition is NOT itself proof that the task changed. `completeBridgeCommand` MUST only be called after the future device-authenticated transport validates the receipt using `verifyAdminBridgeModeReceipt` and, on the device, the independent `verifyPrivilegedBrokerModePostcondition`. Neither a `credentialBinding` field nor the persisted SHA-256 hash is a MAC or digital signature. A cloud owner session cannot unilaterally create a trusted device receipt.

Remaining gates: explicit owner intent confirmation; authenticated Hub-to-paired-Agent command channel; local correct-user/elevated approval; durable cross-restart replay claims at receiver; a verifiable device-signed/credential-authenticated receipt; and a read-only UI result driven by committed verified receipts. Do not deploy an agent that blindly replays previously chosen preferences. Do not modify live privileged tasks until #271 is resolved.

Tests run in isolated SQLite/memory stores and never touch the online devices.
