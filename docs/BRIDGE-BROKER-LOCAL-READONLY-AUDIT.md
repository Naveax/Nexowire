# Broker local process + TCP inventory (diagnostic only)

`scripts/inspect-bridge-broker-local-readonly.ps1` is a pinned Windows PowerShell **read-only diagnostic** for a *future* independently protected Guardian. It inspects the exact `Nexowire Privileged Broker` Scheduled Task, candidate Broker process count from Windows CIM, and distinct TCP listening process owners on loopback Broker port `43112`. Raw process command lines, executable paths, SIDs, PIDs and secrets are never emitted.

The script uses inbox `ScheduledTasks` and `NetTCPIP` module paths and rejects unprivileged collection. A task lookup error, WMI/process enumeration error, port enumeration error, or any opaque possibly relevant node process returns `UNVERIFIED`, never an absence claim. A successful collection is labeled only `SNAPSHOT_ONLY`.

**What this does not establish:** task action or protected source/ACL integrity, a process image matched to a protected launcher, process owner SID provenance, real Guardian or Hub authentication, the owner-approved request, the health probe, or any successful ON/OFF transition. Fields `sourceAclVerified`, `taskActionVerified`, `brokerProcessImageAndOwnerVerified`, `guardianTransportVerified` and `remoteActuationAuthorized` are always `false`. The resulting JSON **must not** be directly passed as a trusted local attestation to the measured receipt builder.

Use only after independently protected installer/local trusted collector integration. The process-name and command-line detection is conservative diagnostic information, not a sufficient proof of the absence of any maliciously disguised process. Further protected evidence collectors and fail-closed policy must independently validate exact executable, full trust chain and trusted task action before real Broker operations are enabled.

Native `work-pc` read-only run on 2026-10-10 returned `UNVERIFIED`; this was correctly not promoted to `Disabled` or `applied`. No live Naveax production Agent/ACL/tasks/Cloudflare Worker or D1 database was mutated. Issue #271 remains OPEN.
