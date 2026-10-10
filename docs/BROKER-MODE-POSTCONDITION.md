# Read-only Admin Bridge mode postconditions

This module is a **read-only evidence collector**. It cannot start, stop, enable or disable Windows Scheduled Tasks.

The canonical local Broker health endpoint is `http://127.0.0.1:43112/`. Alternate configured endpoints are rejected until the trusted installation is explicitly migrated and reverified.

For OFF, a trusted canonical scheduled task must be `Disabled` and the loopback TCP port must explicitly refuse connections (`ECONNREFUSED`). TCP timeouts, permissions errors or other network failures are **unverified**, not absent.

For AUTO/ON, a trusted canonical task must be `Running`, the local listener must accept a TCP connection, and the existing protected-secret Broker probe must report `READY` with reachable/elevated/expected-version checks. A task in `Ready` without actual broker health is **not applied**.

The returned `applied` is an observation of local postconditions only. It is **not a remotely trusted acknowledgement**. A future paired-device channel must authenticate receipts and bind them to the owner-approved intent UUID/current credential digest with an atomic replay ledger before publishing a durable `applied:true` on the web Control Plane.

No live host execution or privileged task transitions were performed by the tests. They use in-process synthetic Task Scheduler status and a temporary harmless Node.js loopback TCP listener.

Related: #323; pending local mode reconciler #327, intent/receipt validation #328. P0 #271 remains an independent production privilege-cutover blocker.
