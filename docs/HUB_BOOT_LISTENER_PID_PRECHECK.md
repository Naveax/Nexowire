# SYSTEM Hub Boot listener PID acceptance (#265 / #271)

A successful HTTP /health response is not evidence that the Hub process
launched by the SYSTEM Scheduled Task owns that TCP listener. An old legacy
Hub or another loopback service may continue to answer on the same port while
an unrelated PID from the launcher file is alive.

Before waitForBootHub accepts startup success it now verifies the exact
Windows Listening TCP connection's OwningProcess is the launcher's PID.
The read-only check uses absolute System32 Windows PowerShell and the inbox
NetTCPIP module, sanitized module/executable paths, bounded subprocess I/O,
and numeric port/PID arguments. Missing, mismatched or unreadable socket
ownership fails closed.

On the isolated Windows development system a disposable loopback Node
server and live Windows NetTCPIP metadata verified that the matching
listener/PID succeeds and an unrelated PID is rejected. No persisted
service, Scheduled Task, network policy or ACL was altered by the tests.

Limitations: This is a point-in-time process/port ownership comparison,
not a cryptographically authenticated health payload, signed code
attestation or durable session acceptance. It cannot authorize the live
Hub handoff or replace the P0 #271 protected-runtime migration and
unprivileged write-denial proof.