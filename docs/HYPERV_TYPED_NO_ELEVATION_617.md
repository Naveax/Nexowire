# P0 #617: Hyper-V typed operation admission, disabled dispatch

**Owner #03 / isolated source-only branch. Production and live VM: NO-GO.**

## Non-negotiable execution boundary

- The standard `shell.exec` / `wsl.exec` process does **not** become elevated.
  No generic shell, command string, named VM, free-form `Start-VM`,
  `Get-VM`, `Stop-VM`, arbitrary executable/arguments, UAC secure-desktop
  click, task privilege, or privileged shell route is added.
- `hyperv.vm.status`, `hyperv.vm.start`, and `hyperv.vm.stop` are **typed
  request schema values only** in `src/security/hyperv-vm-admission.ts`.
  `privilegeRequirement` marks them elevated, but none is present in
  `isPrivilegedBrokerCapability`. No RPC/Agent/CLI/Hyper-V dispatcher,
  elevated helper startup, runspace or PowerShell management API is wired.
- `HYPERV_ELEVATED_DISPATCH_ENABLED=false` and the implementation always
  returns `denied` for fully matching allowed cases. No boolean supplied
  by the caller can turn this into VM status or a mutating operation.
- The request is a strict versioned object containing an **exact,
  lower-case canonical VMId GUID**. Name is never accepted as target.
  Reject wildcard, display-name lookup, duplicate names, script, shell,
  executable, cmdlets, additional fields and `approved:true`.
- The VM GUID grant must be provisioned independently and match exact
  device, owner, current pairing digest, individual capability and
  expiry. An authorization for `start` never authorizes `stop`.
- Source-only admission checks a short window, request ID replay callback,
  signed owner intent, authenticated/version-pinned privileged Broker,
  separately verified Windows token / publisher / image SHA / manifest /
  protected launcher + parent/import/updater ACL, and physical local
  approval. These inputs are **future integration contracts**;
  in-memory examples, incoming JSON and synthetic test values are NOT
  accepted as cryptographic attestations.

## Windows executable/launcher physical *read-only* audit

`scripts/audit-hyperv-launcher-trust.ps1` inspects explicit launcher and
runtime paths with real module-qualified Windows Authenticode verification,
.NET SHA-256, file/directory ACL, low-trust broad-write SID grants and
reparse checks. It never runs either image.

Windows test `test/hyperv-launcher-trust.test.ts` uses only disposable
copies of a **genuinely Microsoft-signed** system EXE as a surrogate to
prove the native Authenticode provider is working. The test corrupts its
own copy and sees signature/hash verification fail. Another test puts
Authenticated Users Modify on its *own disposable directory*, proves
the parent ACL is unsafe and deletes that directory. No changes are made
to real ProgramData, installed Nexowire, Windows task services or users.

Both audit and typed request return:
- `elevatedDispatchEnabled=false`, `productionApproved=false`
- `releaseManifestSignatureVerified=false`: no signed/pinned first-party manifest
- `installedProcessHandleIdentityVerified=false`: no independent running
  binary file-ID/creation authority yet.

A valid signature on a **different Microsoft executable** does not attest
a Nexowire-owned helper. Windows same-user `PROCESS_DUP_HANDLE` on a
Job guardian remains a physically reproduced unresolved boundary (#576).

## Failures and truthful receipts

The typed result is `denied` or `pending` with a denial source,
`effectVerified=false`, `retrySafe=false`, and no invented VM state,
privileged token, PID, console approval or system timestamp provenance.
Losing a network response **after a future actual mutation** requires
an external monotonic CAS reservation and independent signed,
privileged `VMId + VMState` readback, not retrying by the same
request ID or replaying `Start-VM`. There is **no such live path**
in this PR.

Windows UAC Secure Desktop is never navigated or automated. A remote
`approved:true` flag is a schema error. If physical consent is
unavailable, an attempted mutation stays pending or denied.

## Independent acceptance blockers

- **#323** Admin Bridge mode is intent/desired preference, not a
  verified device-side privileged Broker lifecycle/permission gate.
- **#271** legacy elevated `C:\ProgramData\NexowireStack` file/import
  hierarchy inherited Authenticated Users Modify: hard P0 NO-GO.
- **#551** first-party Authenticode-signed installer, independently
  anchored Ed25519 release+rollback manifest, process-image binding,
  controlled ACL cutover and real physical canary are unaccepted.
- **#576** Windows Job helper signed manifest, high-trust runtime image
  and same-user `PROCESS_DUP_HANDLE` isolation remain BLOCKED.
- **#608** exact-head CI 7/7 plus release success proves
  #576 + #598 **source integration only**, not elevated execution
  trust or Hyper-V physical acceptance.
- **#617** dedicated exact VMId broker command/grant/replay, actual
  local physical approval, independently verified Hyper-V state,
  host compatibility and guest rollback tests remain UNSUPPORTED.

No live VM status/start/stop, Hyper-V inventory, service restart, UAC
window, elevation or user process termination was attempted.

## Source tests

- `node --test --import tsx test/hyperv-vm-admission.test.ts
  test/hyperv-launcher-trust.test.ts`
- Windows CI runner has its own explicit test step for these files.
  Hosted exact-HEAD CI is required; local results alone are not release
  authorization.

**Decision: source design and negative checks only; production NO-GO.**
