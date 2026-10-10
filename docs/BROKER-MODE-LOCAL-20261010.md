# Admin Bridge local mode reconciler (not yet wired to web)

This work introduces a **local-only** `reconcilePrivilegedBrokerMode(mode, confirmation, options)` function in `src/agent/privileged-broker-lifecycle.ts`.

## Execution boundary
- Only a currently **elevated local Windows process** with an explicit exact confirmation is eligible. No UAC elevation, silent installer, cloud polling or remote Windows task mutation is added.
- Only the canonical `Nexowire Privileged Broker` task may be changed. The existing task-action, launcher command, Interactive/Highest principal and current Windows user SID checks run before mutation.
- **AUTO and ON** check the protected launcher directory and script ACLs before enabling/starting the task. OFF keeps the existing emergency-stop semantics even when source ACL is unsafe.
- **OFF** disables the scheduled task before stopping its active instance, preventing the recurring one-minute recovery trigger from undoing the off preference. Repeated OFF is idempotent when already Disabled.
- **AUTO and ON** both restore task scheduling and start the task if it is not already running. At this layer the distinction is the requested policy label. Device-side automatic policy evaluation and authorized cloud intent processing are **not implemented**.
- Results explicitly distinguish `taskVerified: true` from `brokerHealthVerified: false`. Scheduler state alone cannot prove that TCP listener 43112 is absent/present or that the authenticated Broker is healthy. Never mark a remote owner preference `applied:true` based solely on this result.

## Tests and future integration
- Windows PowerShell stubbed Scheduled Task tests check off/auto/on action order and idempotency; they do **not** mutate real Windows tasks.
- Error tests assert fail-closed results when disabling or starting the task fails.
- The future paired-device RPC must bind a short-lived owner-approved intent to a device and credential, reject replay/stale intent after re-pairing, run in the correct interactive elevated context, verify the actual PID/port and signed Broker health, and return an explicit acknowledgement to the control plane before UI displays applied.
- Do not automatically apply preexisting Control Plane `device_bridge_preferences` on rollout.
- Live privileged cutover remains blocked by #271. Follow up via #323.

This code is **not** permission to call privileged functions from untrusted ChatGPT tool data or from an ordinary web preference without separate authentication.
