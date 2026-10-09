# Machine updater: reject missing task plans and launchers

The versioned machine-update cutover helper previously wrote a succeeded status even when neither the SYSTEM Hub Boot task nor the privileged Broker task was installed. Its launcher patcher also silently returned when the corresponding launcher file was absent. Both conditions could create a misleading rollout success with zero changed services.

## Fail-closed task plan

- Before patching either machine launcher or stopping any service, the generated cutover script requires at least one existing expected machine Scheduled Task.
- For each existing task, the corresponding protected launcher must already exist as a leaf file; a missing launcher fails the transition instead of silently doing nothing.
- Patch-Launcher also rejects missing launcher files to prevent the preflight-to-write race from silently succeeding.
- The checks live inside the existing try/catch rollback workflow, so a detected failure produces rolled_back status and no successful cutover claim. Valid Hub-only, Broker-only, and both-task configurations remain supported.

## Verification

On Windows work-pc 17/17 tests passed: seven actual isolated PowerShell task-plan mock fixtures for no tasks, missing Hub/Broker launchers and valid task combinations, plus the existing listener/PID identity checks with mocked Windows CIM/TCP results and rollback rendering. TypeScript typecheck and build passed.

## Boundaries

Mocks only. The tests do not register/stop production tasks, modify launcher files, alter DPAPI/OAuth secrets or interrupt sessions. This makes misleading status less likely but does not certify live service availability, permissions, independent release publisher or real high-integrity task recovery. P0 #271 remains open.