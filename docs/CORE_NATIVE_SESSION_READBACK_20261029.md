# Windows CORE session readback component

CORE's grant duration is already `indefinite-revocable` with `expiresAt=null`.
An ordinary successful Agent/provider restart need not ask for approval again.
This does not establish the missing installed native approval authority.

This change supplies a real, read-only Win32 session witness for that future
protected component. It is **not** the approval service, a signed release, a
credential, a human decision, an external monotonic ledger, or an authorization.
Production composition roots and `CORE_EXECUTOR_DISPATCH_ENABLED=false` remain.

`native/windows-core-session-readback.c --readback <64 lowercase hex characters>`
opens only its own primary process token with `TOKEN_QUERY`. It reads the OS
user SID, session ID, AuthenticationId LUID, TokenId/ModifiedId, integrity and
elevation; process identity/creation; WTS active console/protocol/connection
state; process window station, thread desktop and the actual input desktop.
The token is reopened and console/session/desktop observations are repeated.
Replacement, changed context, a backwards clock, overlong readback or missing
OS evidence produces explicit UNAVAILABLE (exit 77). Invalid invocation exits
64. No approval command exists. No token privilege, desktop, input, ACL,
service, scheduled task, enrollment or application state is changed.

The TypeScript parser bounds output, rejects stale/future/wrong-challenge data,
rejects authority/provider booleans, and compares a separately supplied exact
owner SID/session/logon LUID and held process identity. Its result **always**
sets `originAuthenticated=false`, `humanApprovalVerified=false`,
`canAuthorizeCore=false` and `physicalAcceptance=NOT_PROVEN`. Matching stdout
fields alone are not proof that the source binary or its caller is protected.
Do not learn the expected identity from that same stdout and call it independent.

## Remaining provider work

The genuinely protected installed authority must authenticate its caller,
independently provision the account-to-Windows-owner binding, hold and verify
the witness process/code/publisher/import chain, bind genuine human approval to
the current session, consume its receipt once in rollback-independent storage,
and supply fresh authenticated readback to the independent server-side verifier.
It must perform its own final kernel check at the actual effect boundary:
a completed readback is not atomic with a later OS effect, and session switches
can occur between observations. A helper checksum or a signed timestamp does
not close those boundaries. No default endpoint, key, credential or installation
is supplied here. The witness is not bundled or auto-enabled for the Agent.

## Validation boundary

Cross-platform regressions cover scope substitution, changed process creation identity,
nonce replay, stale/future observations, disconnected/remote/private desktops,
unavailable evidence and forged approval/provider flags. The first automatic
exact-head Windows CI compiles with MSVC `/W4 /WX` and runs the read-only native
probe in its disposable runner. The test must identify actual observation
versus OS unavailability; neither result is physical enrollment/containment
acceptance on Naveax or Work PC. No live PC, UAC, ACL, VM, merge or deployment
operation is required or performed.

Win32 API references:
- [GetTokenInformation](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation)
- [WTSGetActiveConsoleSessionId](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-wtsgetactiveconsolesessionid)
- [WTSQuerySessionInformationW](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsquerysessioninformationw)
- [OpenInputDesktop](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-openinputdesktop)
