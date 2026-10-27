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


## Live exact-SHA GitHub API audit

A separate read-only helper fetches the current PR, the supplied workflow run and its complete job list directly from api.github.com using HTTPS and a bearer token. It binds the run to the PR's current head and base SHAs, the pinned CI workflow ID, run attempt, event, all seven job names and each job conclusion. It refuses redirects, foreign origins, partial job pages, stale SHAs and mismatched PR context.

Usage from a checkout:

    GH_TOKEN=<read-only-token> node --import tsx scripts/qa-core-ci-github-audit.ts Naveax/Nexowire PR_NUMBER RUN_ID

The token needs pull-request-read and Actions-read access. The tool makes GET requests only; it does not dispatch, rerun, cancel or modify workflows. It never prints the token. Tests use an injected synthetic fetcher and therefore always report githubOriginAuthenticated=false. A real CLI run may report authenticated GitHub source evidence, but physicalAcceptance remains NOT_PROVEN and productionCore remains NO_GO.

## Live exact-SHA GitHub API audit

A separate read-only helper fetches the authenticated GitHub user, current PR, exact workflow run, the jobs for that specific run attempt, and a final PR snapshot from fixed \`api.github.com\` HTTPS endpoints. For manually dispatched runs, it also resolves the run's commit to its associated pull request. The helper verifies the current PR head/base did not change during the audit, pins CI workflow ID \`369213208\`, checks exact SHA/run/attempt/PR association, and requires all seven expected jobs to be completed successfully. It rejects redirects, foreign origins, partial job pages, stale SHAs, foreign repositories and mismatched PR context.

Usage from a checkout:

    GH_TOKEN=<read-only-token> node --import tsx scripts/qa-core-ci-github-audit.ts Naveax/Nexowire PR_NUMBER RUN_ID

Provide a GitHub user token accepted by \`GET /user\` with read access to pull requests and Actions. The tool makes GET requests only; it does not dispatch, rerun, cancel or modify workflows. It never prints the token. Tests use an injected synthetic fetcher and therefore always report \`githubOriginAuthenticated=false\`. A live run may report authenticated GitHub source evidence, but \`physicalAcceptance=NOT_PROVEN\` and \`productionCore=NO_GO\` remain unconditional.

The audit reads separate GitHub endpoints and cannot create an atomic cross-endpoint snapshot. It rereads the PR at the end and fails closed if the head, base, state or draft status changed while it was running.

## Checkout and per-case evidence are separate from run metadata

The API audit's `snapshotConsistency` assesses only the PR/run/job metadata
it fetches. A pull-request run can report the PR head in `head_sha` while
`actions/checkout` checks out a GitHub-generated merge commit. This helper
does not fetch job logs or compare Git trees, so it always reports
`checkoutRevisionEvidence=NOT_COLLECTED` and
`checkoutTreeMatchesHead=NOT_PROVEN`. Seven successful jobs also do not prove
that any particular Windows Broker test executed; the helper always reports
`windowsBrokerFixtureCases=NOT_PROVEN`.

For a concrete example, #932 HEAD
`be541a10f01c79cb035b78d3525955da6f62d170` had run `40556146804`;
its Node 24 log checked out merge commit
`c9f814fadf22d140aa285021e137adcdf6e62320`. Separately fetched Git
commit metadata shows that merge and the recorded HEAD both have tree
`4568fe7eedaf7470915c2c113eb66947a524c47f`. That equivalence applies only
to those exact commits and does not establish Windows case coverage.

In #932's completed Windows job, the two Windows Broker admission cases were
not scheduled; the Linux jobs reported them SKIP. The separate #933 QA step
runs them on a disposable Windows runner and rejects skipped cases. Its
`87f806163d745949655f33e97d63f6bd352345bf` run `40563535611` is RED
on an existing test-input mismatch. A future source change requires its own
run and evidence; do not reuse that RED or a prior PASS for another SHA.
None of these records proves production CAS, installed Broker or physical
acceptance.

The offline snapshot auditor follows the same boundary: an internally
consistent saved JSON document is not authenticated GitHub data, does not
identify the actual checkout tree and does not prove a required test case ran.
Its matching checkout/case fields remain `NOT_COLLECTED`/`NOT_PROVEN`,
even if callers insert self-reported green flags into the snapshot.

## #919 Node 22 cancellation: bounded evidence

Run `40513511664` at HEAD
`b05c08ffe64cd6fcff21f150b71fc51c1f8bf44d` finished `cancelled`.
Node 22 job `122221488020` reached `npm test`; its last emitted result was
test 108, a skipped Windows-only case in
`test/ai-workspace-strict-policy.test.ts`. The runner then canceled the
operation after roughly six hours and cleaned up a Node worker and esbuild.
There was no completed TAP summary or stack trace identifying the hanging
test or handle. GitHub documents a default 360-minute job timeout, so the
duration is consistent with that limit, but the job log does not establish
the cancellation trigger.

The next cases in the successful Node 24 output belong to
`test/all-ingress-transport-meter-staging.test.ts`. Concurrent/buffered test
output order is not a diagnosis. Both files have the same blob SHA in #919 and
#933, and the different #933 Node 22 run completed those cases. That result
neither proves nor rules out a transient #919-specific issue. The old run
was not canceled or rerun by this QA work.

## Run-attempt recheck after jobs

A workflow rerun can start while a live audit is reading the old attempt's
jobs. The auditor re-fetches the run after the attempt-scoped jobs arrive and
blocks its result if the run ID, attempt, HEAD, branch, workflow, event,
status, conclusion or head repository differs. A missing recheck also blocks.
This narrows the observation window; GitHub does not provide an atomic lock,
so the report does not guarantee the run cannot change after the final read.
It still cannot prove the runner's checkout tree or Windows case coverage.
