# QA36 / #780: Windows restricted worker physical acceptance contract

**Ownership:** Independent QA36. New source-only preflight, adversarial tests, and this contract. **Status: BLOCKED / PRODUCTION NO-GO.** The TypeScript reviewer is not a launcher or native authorization provider.

## Verified baseline

- Main: 754cc4364822be5fda528f54042fb22a84f19924.
- Draft #743: 7bc16b4cd1010803a4b13cdbdf95a1c02578cade; 3 exact-head GitHub workflows completed SUCCESS. Its Windows Job membership tests are not restricted-token acceptance.
- Draft #793: 9f24e7e11301ca9b8e4b8bd59f232f3eb2163d5c; CI 39822912875 SUCCESS, documents process sandbox absence in shell.exec, volatile and durable process.start, and private GUI.
- Current native/windows-job-owner.c uses CreateProcessW with bInheritHandles=TRUE and CREATE_SUSPENDED, assigns the Job, reads process creation FILETIME, publishes NWJOB3, and resumes the shell. Job lifetime containment does not constrain token, filesystem, network, child grants or handle rights. No native restricted-token/AppContainer launch has been verified here.
- Existing same-user synthetic PROCESS_DUP_HANDLE=ALLOW is a physical P0 negative; do not reclassify synthetic Job tests as lower-user protected signer access denial.

## Precise integration requirements for #03 and independent physical QA

#03 must supply a trusted OS-backed provider that consumes independently signed immutable ownerId/deviceId/taskId/requestId/worktreeId/sourceSha/ownerEpoch/expiry. Validate revocation and native executable identity **before first instruction**; refuse unsupported configurations with OS_PROVIDER_UNAVAILABLE and no normal spawn fallback.

1. **Launch and token:** Use CreateRestrictedToken or a correctly configured AppContainer token. Use an appropriate token-aware suspended launch API, inspect OpenProcessToken and GetTokenInformation for TokenUser, TokenRestrictedSids, TokenIntegrityLevel (Low RID no greater than 0x1000), TokenIsAppContainer and AppContainer SID where applicable. Independently verify root and child token consistency, real task-scoped restrictions and installed binary/signer.
2. **Job lifetime:** Assign suspended root before resume. Verify Job membership for root and descendants, nested Job compatibility, breakaway denial, guardian death KILL_ON_JOB_CLOSE, source image, PID and GetProcessTimes creation FILETIME. Ordinary ancestry/Job membership does not prove sandboxing.
3. **Handles:** Require an explicit PROC_THREAD_ATTRIBUTE_HANDLE_LIST of harmless stdin/stdout/stderr only, with no accidental inherited broker, Job, token or protected process handles. Test low-user OpenProcess(PROCESS_DUP_HANDLE) DENIED for the actual signed protected guardian and Job handle. A disposable same-user TEMP guardian is a separate limited witness and is never a substitute.
4. **Filesystem and secrets:** Create a unique disposable task root and controlled outside-root canary, using an unprivileged test identity. Verify root AND child outside read/write denied and protected secret read denied, not merely cwd or app PathPolicy checks. Never alter user files or production ACLs.
5. **Network:** Independently verify denial for DNS, direct-IP TCP, UDP, loopback, spawned children, AppContainer capabilities/exemptions and IPC policy. Test only approved controlled endpoints; Job alone has no WFP confinement.
6. **Grant and recovery:** Separate stale/revoked ownerEpoch, cloned requestId, lost launch/stop ACK and restart. Deny revoked launch. Lost ACK remains UNKNOWN/RECONCILE_REQUIRED and must not mint a new task identity or blindly rerun.
7. **Safe TEMP cleanup:** Identify an exclusively created nonprivileged fixture by unique marker + exact PID + creation FILETIME twice. Only stop that fixture, then independently confirm descendants exited, pipes closed and no surviving privileged handle. No blanket taskkill or guessed PID.

**Required evidence:** OS version/build, native source/helper SHA, signer chain when applicable, grant and revocation epoch, actual token SID/integrity/restricting SIDs, child and Job membership, root/guardian PID and creation times, effective access/handle and network negative results, post-crash recovery, exact test command/result and exact-head hosted CI URL. Maintain a per-gate state PASS / FAIL / NOT_RUN / UNSUPPORTED. Never imply physical PASS from synthetic objects, GitHub CI, local JS success, self-reported JSON or Job ownership alone.

## Source-only QA36 behavior

src/security/windows-restricted-worker-preflight.ts returns decision BLOCKED, runtimeDispatchAuthorized=false and INDEPENDENT_OS_PROVIDER_NOT_ATTESTED **even for a fully populated forged claim**. It identifies missing grant binding, stale epochs, unsupported Job-only or ambient launches, ambient environment/handle inheritance, missing Low integrity or restricted SID, AppContainer exemption, missing FS/DNS/TCP/UDP/loopback denies, protected PROCESS_DUP_HANDLE, revoked admission and lost-ACK replay. claimsCompleteForIndependentReview means only syntactic completeness, never authorization.

test/p36-780-windows-restricted-worker-preflight.test.ts uses deterministic source-only objects, not Windows processes or actual network access. Physical installed-signer and lower-user tests remain BLOCKED until authorized independent infrastructure is supplied.

**Owner handoff:** #03 native token + handle-list + Job, #04/#13 signed authority and network, #05 filesystem/worktree, #17 protected low-user handle QA, #01 immutable mutation journal/UNKNOWN, #00 production acceptance. No #03 protected source edit, live Agent, signed Broker, ACL/UAC, service, VM, user process or main merge in QA36.
