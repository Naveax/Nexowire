# Signed owner → Hub → Guardian → Hub Bridge command roundtrip (test-only)

The individual command/receipt protocol, policy preflight, proof-of-possession and postcondition checks now have an integrated **synthetic** test that runs without a privileged Windows service or production connection.

`test/guardian-bridge-signed-roundtrip.test.ts` creates ephemeral in-memory Hub and Guardian Ed25519 keypairs and a fake owner + paired win32 device in `MemoryControlPlaneStore`. For ON/OFF/AUTO it:
1. Saves an owner-desired Bridge preference and **independently issues** a short-lived owner-approved mode command (not an automatic consequence of a UI preference).
2. Claims the one-time command for the authenticated paired device.
3. Signs the exact Hub command including latest preference revision, local Guardian key ID, device/owner/credential binding and request ID.
4. Verifies its signature against a separately pinned Hub public key. Its atomic reservation callback also performs the full independent protected-Guardian/owner-approval policy check, avoiding double-consumption of the same request ID.
5. Simulates local read-only Scheduled Task, Broker process/TCP and authenticated health evidence (no real Windows changes).
6. Creates a conforming success or failure receipt, signs it using the synthetic Guardian key and invokes the server's existing signed-receipt finalizer.
7. Confirms the owner sees the correct final state, and replay is refused.

Negative cases assert that OFF with a lingering listener produces a **failed** signed receipt, missing independently reachable Guardian blocks before reservation, and a replaced/revoked enrolled Guardian public key cannot complete a claimed command.

**Safety:** All trusted Guardian facts, process observations and private keys in this test are fixtures. A fake local collector that returns `true` does NOT prove the real Windows task changed state. This test is not a production implementation of local Guardian privileged execution or durable local replay persistence. The Windows scheduled task is **never started/stopped by the test**. Real onboarding still requires P0 #271 secure cutover, independently protected installed Guardian, authenticated bidirectional transport, protected signer enrollment, durable local transaction and independent OS measurements.

No Cloudflare Worker/D1 deployment, live Agent update or production Windows mutation is performed.
