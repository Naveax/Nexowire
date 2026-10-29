# CORE P0 System QA/CI Evidence Boundary (2026-10-27)

Scope: independent **#11 system QA only**. No production Agent, Broker, UAC,
Windows ACL, Service, VM, enrollment, deployment or external CAS mutation.
This document and the accompanying CI JSON auditor are **source-only**;
neither authorizes CORE nor authenticates a physical receipt.

## GitHub evidence checked at this snapshot

Current `main`: `bd519ee52d56956edfddb1e06bb0856e54e50419`.

| Draft PR | Exact HEAD | Base SHA | Workflow run | Event | CI jobs |
| --- | --- | --- | --- | --- | --- |
| #702 | `43ffa6e98e0b8ea521e36bf37d9d58cf4a2bdba9` | `b935a594a68c2ba3e043b0731e5eb6d01081fa07` (#676 stack) | 40485276770 | pull_request | 7/7 completed/success |
| #627 | `ef38bea53bf2d917e52edce7a858ff1d23b59c8c` | `bd519ee52d56956edfddb1e06bb0856e54e50419` | 40486317372 | pull_request | 7/7 completed/success |
| #665 | `6c85683014156b32f7daf4da6a768d23ab72a203` | `bd519ee52d56956edfddb1e06bb0856e54e50419` | 40486425093 | pull_request | 7/7 completed/success |
| #576 | `f908bebfa202a5b01c41f7b168c7e87457aa0b21` | `4c5c810134c020cd04a5ef2be5c1138ea1954ad0` | 40489164389 | workflow_dispatch | 7/7 completed/success |

GitHub Actions REST run metadata independently matched exact `head_sha`,
`workflow_id=369213208`, `run_attempt=1`, status `completed`,
conclusion `success`, and each run's seven completed/success job records.
Prior successful SHA is never inherited by a new SHA. Never rerun an already
active matching SHA/workflow/input; monitor its existing run ID.

The 7 required job names are `test (22)`, `test (24)`,
`browser-live`, `linux-native-live`, `wsl2-live`,
`security-operational-live` and `macos-agent-lifecycle-live`.
The `live` substring is CI job naming, **not two-device production proof**.

## Physical production acceptance remains NO-GO

| Release gate | Current source-only status | Independent evidence still required |
| --- | --- | --- |
| Monotonic external CAS | #702 source adapter, #676 SQL/TLS client and synthetic QA | Operational independent rollback-resistant monotonic authority, atomic owner/device/session epoch reserve/commit/revoke/drain, immutable UUID history; actual loss/recovery tests |
| Publisher + rollback | #576 signed-package checks and negative unit tests | Pinned production publisher, trusted signature and rollback-bound manifest, protected installation and cross-version downgrade refusal |
| Actual High token + ACL | #576 OS helper and #665 injected-provider diagnostics | Native same-PID elevated token and admin-enabled verification; protected executable, imported modules, parent directories, process/guardian handle ACL readback |
| Local enrollment | #627/#665 strictly distinguish claimed intent from proven authority | Explicit physical console enrollment on Naveax and Work PC, independently authenticated owner/device/session grant readback and revoke/re-pair |
| Revoke, restart, soak | Synthetic concurrency, UNKNOWN/lost-ACK, Job tests exist | Two-device staging test: actual revoke while effect in flight, Broker/Agent restart, breakaway/nested Job/handle containment, prolonged soak with independent process-tree and state evidence |

Historical observations recorded in #627 show both devices
`localEnrolled=false`, `CORE.active=false`,
`LOCAL_ENROLLMENT_REQUIRED` on 2026-10-27. Those are **not**
installation instructions or a request to bypass consent.

## QA utility, threat model and limitations

`scripts/qa-core-ci-evidence-audit.ts` checks a caller-supplied JSON
snapshot for exact run ID, 40-digit SHA, workflow ID, attempt, event, 7 named
completed/success jobs, job/run association, duplicates, and skipped jobs.

The input format is:
```json
{
  "expected": {"runId": 123, "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "workflowId": 369213208},
  "run": {"id": 123, "head_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "workflow_id": 369213208, "status": "completed", "conclusion": "success", "event": "pull_request", "run_attempt": 1},
  "jobs": [
    {"name": "test (22)", "run_id": 123, "status": "completed", "conclusion": "success"}
  ]
}
```
The JSON above is an **incomplete synthetic example**, never passing evidence.
Provide all seven GitHub jobs from the corresponding run for a valid
consistency check.

Run: `node --import tsx scripts/qa-core-ci-evidence-audit.ts snapshot.json`.
Do not include credentials, secrets, logs or native device identifiers.
Input should be collected from read-only GitHub Actions REST run + jobs,
with independently authenticated GitHub access. A JSON file, even all-green,
can be forged; this utility deliberately returns
`githubOriginAuthenticated=false`, `physicalAcceptance=NOT_PROVEN`,
`productionCore=NO_GO` **in every case**. Its success code only means
internal structure agrees; it is not acceptance of the authority source.

New automated QA regressions check exact SHA mismatch, stale workflow,
duplicate or missing jobs, foreign run/job SHA, skipped/failed jobs,
invalid attempts/events, and forged physical flags. The tests use only
synthetic JSON fixtures and never touch the connected devices.

## Required next independent handoffs

- **#01 / trust witness**: real hosted monotonic CAS service and protected
  operator credentials; validate historical rollback and concurrent revoke.
- **#02 / Windows Broker publisher**: externally signed release manifest,
  immutable publisher trust anchor, actual guardian/token/ACL verification.
- **#04 / enrollment**: real local owner confirmation, durable device/session
  epoch and revoke/re-pair readback; no remote simulated console approval.
- **#07 / containment and #11 QA**: physical two-host revoke/restart soak after
  above gates become available. Do not touch `ReVoltVPN-Ubuntu-Lab`.

No CI reruns, PR merge, production service, device, UAC, ACL, or live
installation modifications are performed by this QA change.
