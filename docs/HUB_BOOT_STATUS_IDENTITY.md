# Hub Boot status cannot certify an unverified Windows Scheduled Task

The prior read-only Hub Boot status path treated any root-folder Windows
Scheduled Task with a selected name as an installed SYSTEM Boot task.
It also returned a PID from a file if that process existed, even when
no matching Boot task was installed.

The new status probe requires the exact canonical pair of task names and
runs the existing read-only Scheduled Task action/owner/runlevel identity
guard on the root-folder SYSTEM Boot and current-user Hub task before
reporting installation state. A foreign task using the canonical name
does not become a trusted installation. A PID is reported only when the
Boot task is verified present and the PID is still alive.

This is a source-only status integrity improvement, not remote task
execution, runtime code attestation, a production cutover or completion
of the legacy writable Stack P0 #271.