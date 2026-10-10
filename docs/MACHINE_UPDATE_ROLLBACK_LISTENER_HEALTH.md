# Machine cutover: verify recovered Hub and Broker listeners

An elevated machine update can fail after stopping/restarting Hub or Broker. The previous rollback branch verified that launching the old Scheduled Tasks did not throw, and that launcher file restoration hashes matched, but it did not verify that the previous runtime actually regained TCP listener ownership. Windows Start-ScheduledTask can report success even if the Node process exits immediately or a different version still owns the port. Reporting rolled_back in this case is misleading.

## Source correction

- Record the unique validated prior version root for each Hub/Broker launcher as the launcher is inspected, including already-current no-op launchers.
- Reuse the existing same-PID TCP listener + Win32_ProcessExecutablePath + exact imported CLI and mode audit with an explicit runtime-root parameter. The default remains the new version for normal cutover acceptance.
- Only during rollback after real task cutover, and only for installed tasks, require Hub TCP 43110 and Broker TCP 43112 to be owned by the correct previous versioned node.exe and cli.js running in their corresponding modes.
- If the old listener never returns, a new version retains the socket, a foreign executable or CLI owns it, or the previous root was not captured, record a HUB_HEALTH / BROKER_HEALTH recovery failure and write rollback_failed, not rolled_back.
- Preserve source-only preflight rejection behavior: errors before any task stop still restore any patched launcher but do not bounce live services. Maintain the existing separate reports for failed task stop, launcher restoration or task restart.

## Work-pc validation

33/33 focused Windows tests passed, including generated PowerShell task cutover/rollback simulations, recovered-listener failure status and isolated actual Windows PowerShell socket/CIM mocks proving that the *old* Node binary, CLI and Hub mode must all match. The new version still listening, a foreign Node binary, wrong CLI, and wrong mode are rejected. TypeScript typecheck, build and diff check passed.

## Production boundary

This checks observable old runtime TCP listener ownership on rollback, not the full functional health of OAuth, DPAPI, all device connections or background jobs. No live Highest tasks, ACLs, Hub/Broker ports, credentials, Agents or sessions have been changed. The writable installed legacy runtime is still a separate P0 #271 blocker and requires an authorized administrator-owned migration and full release provenance.