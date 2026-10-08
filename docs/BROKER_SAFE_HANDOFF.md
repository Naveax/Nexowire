# Broker handoff preflight and controlled repair contract

Tracking: GitHub Issue #260.

## Read-only tool

`scripts/broker-handoff-preflight.ps1` inventories local loopback listening PIDs for
Broker (43112) and Hub (43110), checks that they are separate, checks whether the
old Stack supervisor avoids respawning a Broker when a protected task exists,
summarizes protected task metadata and last run result, checks the staged v1.0.5
tarball/Windows ZIP against their release checksum files, and inspects the staged
Broker for the authenticated `/health` endpoint.

**The tool is deliberately incapable of switching Broker processes.** It always
reports `safeToChangeProcesses: false`, `actionsPerformed: READ_ONLY`. HTTP
401 alone is never proof of elevated readiness.

The script is intended to be reviewed and run locally with authorized operator
access. A remote execution attempt from the limited Agent session on work-pc
was blocked by the host's security controls, so **no live result from this
new handoff script is claimed**. PowerShell syntax and static no-mutation
properties were verified by the automated test suite.

## Verified site-specific observations

On Naveax, the v1.0.5 Native Agent uses Broker mode, but the v1.0.0 legacy
Stack owns the loopback 43112 listener (PID 7712 at observation time) and its
Broker lacks `GET /health`. The separate Highest task is automatically
attempted but returns result 1. Do not assume the result 1 is definitively
caused by port collision until the protected task action and logs can be
inspected by a Windows-authorized administrator.

The legacy `run-stack.ps1` supervisor includes the guard:

- It launches its own old Broker **only when** no `Nexowire Privileged Broker`
  scheduled task exists AND 43112 is not listening.
- Hub uses 43110 and is supervised independently.
- The Broker scheduled task exists; therefore the legacy supervisor should
  not respawn the old Broker after isolated retirement, provided the script
  and task have not changed.

Even with this guard, **do not kill PID 7712 on the basis of a PID alone**:
a PID can be reused, a different process can own the port, and the
protected task may have an unknown binary or secret-source mismatch.

## Required acceptance gates before any switchover

1. **Operator identity:** authorized machine owner, locally elevated Windows
   session. Confirm approved principal, task owner, Highest RunLevel, and
   protected launcher exact command and integrity. Do not display credentials.
2. **Proven staged binary:** verify SHA-256 against release metadata and verify
   trusted distribution authenticity, dependencies and bundled files. A hash
   from a mutable user directory alone is insufficient for elevated execution.
3. **Protected install:** copy verified Broker code into an admin-protected
   executable directory with correctly restricted ACLs. Never run code directly
   from the user-writable staging folder under Highest.
4. **Protected secret:** confirm DPAPI secret accessible by the intended
   Windows user and no plaintext token variable or logs. Never export tokens.
5. **Isolation:** verify the 43112 process is precisely the legacy Broker;
   Hub 43110 and all durable workers have different PIDs and cannot be
   affected by process-tree termination.
6. **Reversible handoff:** have an approved, tested rollback path with the
   old runtime configuration available before touching the old Broker.
7. **Maintenance execution:** use existing Windows elevation/UAC approval to
   retire **only** the verified legacy Broker process and start a single
   approved task. Do not restart Hub, Native Agent or Stack supervisor.
8. **Readiness:** unauthenticated `GET /health` should be 401, and an
   authenticated `nexowire privileged-broker probe` must return exactly
   `reachable=true, elevated=true, version=1.0.5, ready=true` with exit 0.
   Roll back on every other result. No simulated flags.
9. **Owner control-plane acceptance:** after an approved reconnect/hello,
   verify `adminBridgeReady=true` for Naveax, real 15-minute ROOT enable,
   expiry/revoke and audit events under the signed-in owner. Validate a harmless
   elevated operation within Broker's existing approved capability scope.
10. **Postconditions:** Hub, Agent and protected hourly updater are running,
    Naveax long-lived sessions unchanged, no secrets in logs, work-pc online.
    Preserve failure evidence for Issue #260.

## Status

The new preflight is code-complete with static and PowerShell parser tests.
It does not perform the privileged maintenance change and **does not** mark
Naveax ROOT fixed. Existing v1.0.5 release archives are already staged on
Naveax with their published SHA-256 sums, but no executable was installed
or started in this step.
