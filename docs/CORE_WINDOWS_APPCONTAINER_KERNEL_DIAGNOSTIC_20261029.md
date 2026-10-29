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

The restricted-token head `b82d3b738197c8d3ee829fa4efe64fa18088e197`, CI
`40915123658`, completed its workflow while the native case remained BLOCKED
at token setup with ERROR_ACCESS_DENIED (5). This is not containment success.
Source inspection identified that CreateRestrictedToken preserves source
handle access rights: QUERY|DUPLICATE was insufficient to lower the NEW token
or attach it as primary. The follow-up requests the exact ADJUST_DEFAULT and
ASSIGN_PRIMARY handle rights too, without modifying the parent's token. It
also reports token creation versus integrity lowering as distinct stages.
All AppContainer/LOW/non-elevation/privilege/group/Job checks remain mandatory.
After handle correction, actual CI `40918967777` again rejected the suspended
child: Administrators was deny-only and privileged entries were absent, but
TokenIsElevated still equaled 1. The next source requests LUA_TOKEN explicitly
in addition to DISABLE_MAX_PRIVILEGE; the kernel must independently report
non-elevation or execution remains denied. No fact is synthesized from a flag.
At follow-up head `a1a533b15df9a844c6b0b834d7d84d0404cb2ad4`, CI
`40920509967`, actual readback finally showed non-elevation, LOW, zero ambient
privileges/capabilities, matching package and deny-only Administrators. The fixed
child then failed during native startup with 0xC0000142. That remains RED.
The next source creates a unique noninteractive test window station and desktop
with explicit owner/AppContainer access and a LOW label, passes that exact path
to CreateProcessAsUser and verifies OS station/desktop names inside the fixed
child and descendant. This addresses the documented desktop access requirement;
the cause of 0xC0000142 is not presented as proven until the actual rerun of the
NEW source head completes. WinSta0/Default ACL and input desktop are never
modified or switched; temporary objects/handles belong only to the diagnostic.
The private-desktop head `de49782fea95bc42f902671f1b3149bb5d0c6c55`, CI
`40921623886`, still observed 0xC0000142. Desktop creation therefore was not a
proven resolution. The following source additionally gives only the NEW worker
token an explicit owner/AppContainer/SYSTEM default DACL for its own newly
created objects, rather than depending on an Administrators-only inherited
default after that group becomes deny-only. Actual default owner ACE presence
is read before and after; no user SID, credential or token content is printed.
The parent token and every existing object ACL remain untouched. This is a
startup boundary correction and diagnostic hypothesis, not a claim that the
underlying DLL initializer has already been identified or containment passed.
The fixed child is now compiled separately from the same guarded source with
static CRT and only its token/file/network/desktop-observation dependencies.
Profile creation, token construction and userenv imports remain in the parent
diagnostic only. The parent copies one exact sibling fixture name, never an
arbitrary caller executable. The child accepts only the two fixed internal
test modes; it cannot create profiles or act as the parent launcher. Both
binaries are unsigned disposable CI artifacts, not installed publisher proof.

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
- https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken
- https://learn.microsoft.com/en-us/windows/win32/secauthz/access-rights-for-access-token-objects
- https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw
- https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-createwindowstationw
- https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_default_dacl
