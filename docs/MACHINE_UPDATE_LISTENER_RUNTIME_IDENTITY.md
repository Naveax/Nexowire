# Machine updater: listener-to-runtime process identity

During an approved elevated Hub/Broker release cutover the updater starts new Scheduled Tasks and checks health. The old readiness logic separately accepted any listener on TCP 43110/43112 and any Node process with the expected new runtime command line. Those two conditions could be satisfied by DIFFERENT processes, allowing a stale old listener to masquerade as a successfully migrated service.

## Source changes

- Replace separate Wait-Port and Wait-Mode polls with Wait-Service(port, expectedMode, timeout). For every listening TCP socket reported by Get-NetTCPConnection, obtain OwningProcess and query that exact PID through Win32_Process. Only succeed when that exact socket owner is node.exe, Win32_Process.ExecutablePath equals the expected versioned NewRoot\\runtime\\node.exe, and its command line names the expected NewRoot\\app\\dist\\src\\cli.js and target Hub or Broker mode.
- Keep the 30 second Hub and 20 second Broker deadline, existing task names, backup/restore and failure state writes. If a different process owns the listener, the update enters its existing rollback path rather than incorrectly reporting success.
- Match both quoted and unquoted cli.js mode syntax and require a bounded mode argument (http or privileged-broker run), rather than trusting a free-floating unrelated node.exe on the host.

## Windows validation

The initial 20/20 focused work-pc tests passed. Further tests also reject a foreign node.exe binary with a forged new CLI command line and the real versioned node.exe given a different CLI plus a spoofed new-root argument. All eight isolated Windows PowerShell owner/PID/executable/CLI mode scenarios passed. The final complete targeted suite is rerun for the revised commit. Typecheck, build and diff checks passed.

## Deployment boundary

This does not run any actual Scheduled Task, stop Hub/Broker or change live ACLs or credentials. A matching listener PID/commandline is necessary but not sufficient independent publisher authentication, health of the entire service or recovery proof. Root protection, low-privilege write denial, user-approved elevated rollback and complete release trust remain required before live cutover. P0 #271 remains open.