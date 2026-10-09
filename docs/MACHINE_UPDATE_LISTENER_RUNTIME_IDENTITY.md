# Machine updater: listener-to-runtime process identity

During an approved elevated Hub/Broker release cutover the updater starts new Scheduled Tasks and checks health. The old readiness logic separately accepted any listener on TCP 43110/43112 and any Node process with the expected new runtime command line. Those two conditions could be satisfied by DIFFERENT processes, allowing a stale old listener to masquerade as a successfully migrated service.

## Source changes

- Replace separate Wait-Port and Wait-Mode polls with Wait-Service(port, expectedMode, timeout). For every listening TCP socket reported by Get-NetTCPConnection, obtain OwningProcess and query that exact PID through Win32_Process. Only succeed when that exact socket owner is node.exe and its command line identifies the expected versioned NewRoot and target Hub or Broker mode.
- Keep the 30 second Hub and 20 second Broker deadline, existing task names, backup/restore and failure state writes. If a different process owns the listener, the update enters its existing rollback path rather than incorrectly reporting success.
- Match both quoted and unquoted cli.js mode syntax and require a bounded mode argument (http or privileged-broker run), rather than trusting a free-floating unrelated node.exe on the host.

## Windows validation

20/20 focused work-pc tests pass: generated cutover contract, earlier ACL/preflight protections, and six real isolated Windows PowerShell tests with mocked Get-NetTCPConnection/Get-CimInstance including success when port and requested process match, false rejection when old process owns the socket but unrelated new process runs, wrong mode, wrong executable, and Hub/Broker mode collision. Typecheck, build and diff checks passed.

## Deployment boundary

This does not run any actual Scheduled Task, stop Hub/Broker or change live ACLs or credentials. A matching listener PID/commandline is necessary but not sufficient independent publisher authentication, health of the entire service or recovery proof. Root protection, low-privilege write denial, user-approved elevated rollback and complete release trust remain required before live cutover. P0 #271 remains open.