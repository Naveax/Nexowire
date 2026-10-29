# Fixed-payload AppContainer kernel diagnostic

This adds a real native Windows CI diagnostic, not a production worker. The
existing #07 runtime API remains deny-only. No arbitrary executable, shell,
command, script, network target, installed Broker or caller boolean is accepted
as authority. The diagnostic binary is unsigned and not bundled or installed.

Only a disposable CI runner's newly generated test directory/profile/processes
are changed. A unique AppContainer profile has no capabilities. The helper
copies its own fixed payload into a new read-only fixture directory, grants
that unique AppContainer access only to fixture code/data, and labels its new
scratch data low integrity. An outside canary excludes the AppContainer SID.
No existing user files, installed ACL, task, service, UAC or VM is changed.

The payload is created suspended, with a minimal explicit environment and no
inherited handles. The parent assigns an unnamed kill-on-close Job before
resuming and independently reads the held process's actual AppContainer SID,
low integrity, non-elevation, zero capabilities and Job membership. The fixed
child checks its allowed file, denied canary read, missing parent secret,
denied PROCESS_DUP_HANDLE access to the exact still-running test guardian,
and WSAEACCES on the parent's live disposable loopback listener. A normal
unsandboxed positive control first connects to that same test listener.

The child rejects successful breakaway, creates one fixed normal grandchild,
then exits. The parent opens and independently checks the descendant's token
and exact Job membership/PID list. Closing the sole Job handle must signal the
held descendant process. Cleanup terminates only handles created by this test,
or a descendant whose AppContainer and Job identity have been verified; a PID
from a writable test file alone cannot authorize terminating a foreign process.
The unique test AppContainer profile is deleted and the caller removes its
known temporary directory. Cleanup failure is a failing result.

Missing OS APIs, unsupported nested Job/process creation or profile setup
produce explicit UNAVAILABLE/BLOCKED, never simulated success. Actual invariant
violations produce FAILED. The Windows test reports which path happened. A
successful result is only OBSERVED for this fixed diagnostic and always has
`coreAuthority=false`, `productionWorkerInstalled=false`, and physical
acceptance NOT_PROVEN. A skipped result is not a production PASS.

The first actual CI run `40909361627` compiled this diagnostic but reported
UNAVAILABLE at `suspended_appcontainer_create`, Win32 error 203
(ERROR_ENVVAR_NOT_FOUND). That skip is NOT a containment PASS. The follow-up
builds an OS environment from the held user token with parent inheritance
disabled, copies only nine explicit Windows profile/system path keys, and
forces PATH to the real System32. The complete OS/parent environment block is
never passed. The real child still has to reject the parent-only secret and
satisfy every previous kernel invariant; none is weakened or skipped away.

The subsequent actual kernel readback at #967 head
`3a727b277b6a04cab94aa2df0a520efe74bae914` showed AppContainer=1, LOW=4096,
zero capabilities and matching package, but elevation=1. The original strict
check rejected it before resume; LOW/AppContainer alone was not accepted as
non-elevation. The next source correction creates a genuinely restricted
version of the caller token, disables maximum privileges, makes Administrators
deny-only and lowers only that new token. It launches with CreateProcessAsUser
plus AppContainer attributes and independently checks the resulting suspended
token again. Any privileges beyond SeChangeNotify (even disabled entries that
could later be re-enabled) and live Administrators membership are additionally
rejected. No existing check is weakened, no parent
token or machine privilege is changed, and no new account/logon/password,
linked-UAC impersonation, credential or fallback is created.

Still missing for a production #07 worker: a protected signed launcher and
caller-authenticated immutable task policy; artifact/root provenance and
hardlink/reparse race resistance; private desktop/input isolation; complete
external IP, DNS, IPv6, COM/IPC and service-mediated escape denial; WFP rules;
quota and independent cancellation/revoke/UNKNOWN reconciliation; standalone
physical tests on the actual installed Naveax and Work PC trust chain.
AppContainer permits some common resources and some input surfaces; this
diagnostic does not call that a complete sandbox. #03 dispatch and CORE hard
enable flags are untouched. No live installation, merge or deployment occurs.

Primary platform references:
- https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer
- https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation
- https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
