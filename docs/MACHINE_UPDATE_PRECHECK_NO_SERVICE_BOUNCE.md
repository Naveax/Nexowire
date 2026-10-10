# Machine cutover: preflight failures must not bounce live services

The generated elevated cutover helper used one shared catch branch for (1) validating task identities and preparing launcher files and (2) actually stopping, updating and restarting machine services. If an initial task identity check or second launcher patch failed, the catch branch still stopped and restarted both existing live Hub/Broker tasks even though no service cutover had begun. This made a rejected update capable of causing a needless production outage.

## Source correction

- Initialize $cutoverStarted=false before entering the helper's existing try/catch.
- Perform entire task-plan verification and both launcher patch attempts before flipping $cutoverStarted=true. Only the phase beginning with the first real scheduled-task stop is considered service cutover.
- On failure before the cutover phase, restore any previously patched launchers but do not stop/start any Scheduled Task or introduce the recovery wait.
- After the cutover phase starts, keep existing stop/restore/restart recovery and separate rollback_failed status on recovery errors.
- Preserve exact Task Scheduler principal/launcher validation, version path consistency, listener PID/runtime identity check and protected staging restrictions.

## Verification

25/25 focused real Windows work-pc tests passed at initial run, including five actual isolated PowerShell execution scenarios with mocked task APIs: preflight rejection yields zero stop/start operations, second launcher patch failure restores the first but leaves both services untouched, failed restore reports rollback_failed with no task bounce, actual cutover health failure triggers service recovery, and valid cutover still succeeds. Only the test's TypeScript unchecked array type required an additional narrow; complete regression, typecheck and build were rerun afterwards.

## Production boundary

Tests execute the actual generated PowerShell cutover control flow but mock all Task Scheduler, launcher, network and status operations. No production tasks, live Hub/Broker/Agent sessions, device ACLs, OAuth/DPAPI secrets or publisher identity were changed. This prevents needless service interruption on preparation failures but does not prove successful rollback health on a live elevated session or resolve the writable legacy Highest runtime. P0 issue #271 remains open.