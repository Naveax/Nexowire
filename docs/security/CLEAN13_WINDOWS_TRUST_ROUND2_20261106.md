# CLEAN-13 Windows executable trust | AI-02 Round 2 evidence and custody contract

Date: 2026-11-06. Source owner: [#1077](https://github.com/Naveax/Nexowire/pull/1077).
Integration owner: [#1089](https://github.com/Naveax/Nexowire/pull/1089).
**Security verdict: WINDOWS PRODUCTION CLOUDFLARED LAUNCH NO-GO.**
This is an evidence-and-design addendum; it does **not** authorize a production launcher, WDAC policy deployment, live tunnel, or machine mutation. The existing Windows guard in `src/mcp/cloudflare-binary-trust.ts` must remain fail-closed.

## Exact source checkpoint, independently read from GitHub

| Ref | SHA / state |
| --- | --- |
| main | `939b4d6beecf996f2750c736c5d4b4beb7b64488` |
| #1077 pre-addendum HEAD | `f49fbc070cd27a8c6b4c1d3f576484f95a3f14a8` (Draft) |
| #1089 integration HEAD inspected | `37fc9163e2b7ccd93600ee23b63f19d4e44ddb77` (Draft) |
| Native probe blob, IDENTICAL in #1077/#1089 | `6bb541f9b64fa3880f5fd77ca5ce5abe255e0fa8` |
| Native negative test blob, IDENTICAL | `966f1e1bbea1fca9eed939881dff82b13a916585` |
| Cloudflared trust runtime blob, IDENTICAL | `42dae15a1d787061a6d0df943e7247ac6261d438` |
| #1077 exact-SHA CI | `42107767779`, completed FAILURE |
| #1089 exact-SHA CI | `42109204286`, completed SUCCESS (16/16 jobs) |
| #1089 Relay QA / Release Readiness | `42109204241` / `42109204414`, completed SUCCESS |

Use fresh HEAD, blob and CI checks before copying this addendum into an integration candidate. A CI run that tests a prior SHA is not an attestation of a newer SHA.

## Owner classification of the Windows process-tree stop failure

#1077 Windows browser-live job `127527269341` ran CLEAN-13 native source test, native signed-source guard, SID/ACL tests, and cache-only whole-chain revocation flag guard: **PASS**. In the same job, test `test/cloudflare-connection-lifecycle.test.ts:125` failed `task stop must stop the managed parent` (`actual=true` after Stop-ScheduledTask).

Old #1077 `src/mcp/cloudflare-connection-lifecycle.ts` used a PowerShell `& node.exe ...` task action. Stopping its scheduled PowerShell owner does not guarantee killing independent Node parent/descendant processes. There was no Job Object lifetime binding.

In #1089, the corresponding source uses `CreateJobObject`, `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, `CreateProcessW(CREATE_SUSPENDED)`, `AssignProcessToJobObject` before `ResumeThread`, and `CloseHandle(job)` on owner exit. The actual identical semantic stop test **PASS** on Windows job `127532260288` and the integration CI also logged **20/20** real disposable Windows Scheduler start/stop and descendant-cleanup cycles. The #1089 lifecycle source blob on that HEAD is `a89174b3d30c70f896616cab0f539476c210944a`.

**Owner: V2-04 Windows connection lifecycle / AI-05 integration, not the CLEAN-13 binary trust and credential custodian.** Do not backport lifecycle code into #1077 merely to turn this stacked, historical source CI green. Do not remove the process-tree assertion or replace Job cleanup with bare PID-kill (PID reuse).

#1077 Node22 job `127527269525` failed 8 unrelated inherited P1-C/HTTP redirect/revocation cases; Node24 was cancelled. None of these is proof of a failed WinTrust result. #1089 CI success is an integration regression result, **not** a physical-device acceptance or secure executable launch verdict.

## Real hosted Windows negative results

| Claim | Verification | Evidence / limitation |
| --- | --- | --- |
| Approved flat SHA256 + Authenticode positive | PASS | #1077 `127527269341`, #1089 `127532260288`, official pinned test fixture |
| Held `WINTRUST_FILE_INFO.hFile`; cache-only `WTD_REVOKE_WHOLECHAIN` | PASS for positive fixture | Native probe; does not itself prove rejected revoked chain/CA in a controlled revoked-certificate fixture |
| A matching caller-provided SHA256 for *unsigned* bytes | DENIED / PASS negative | Native `stage=HELD_WINVERIFYTRUST` negative, checked within the Windows image probe test |
| Suspended process, held source FileIdInfo, reopened process-path FileIdInfo, MEM_IMAGE mapped-path name | PASS (observation) | Probe ALWAYS terminates child, never resumes; **not** a trusted kernel section-handle binding |
| Leaf reparse/symlink, ancestor junction, multiple hard links, corrupted source SHA | DENIED / PASS negatives | Disposable signed file copy in native Windows test |
| Same-SID write/delete/rename/parent rename after held source + ancestor open | Blocked / PASS negatives | Real independent same-user attacker, not a preexisting writable-mapping test |
| Windows credential foreign SID/ACE, inherited ACE and parent replacement | DENIED / PASS negatives | Hosted Windows fixture; NOT full independent multi-account / production credential rollout |
| Standalone executable image-section provenance | NOT_PROVEN | No signed installed native custodian; no attested kernel section object |
| Enforced and correctly scoped App Control for Business / UMCI | NOT_PROVEN | Hosted read-only CiTool inventory saw 3 enforced policies but `policyScopeProven=false` and `actualBlockEventProven=false` |
| Revoked-publisher, wrong-version-but-signed, prior writable mapped view, alternate-stream and cross-SID substitutions | NOT_RUN | Requires independent controlled fixtures and dedicated disposable VM |

The readiness script explicitly reports `nativeHeldImageSectionCustodianImplemented=false` and `productionLaunchGO=false`. A signature `Subject -match Cloudflare` is only an auxiliary heuristic; exact flat SHA pin and future reviewed signer/public-key/chain rules must remain independent.

## Native custody architecture (PROPOSED, not implemented)

**Trust anchors:** Independently reviewed per-release flat SHA256 and immutable release manifest; designated native launcher signing identity and catalogued signer-key continuity; owner-authorized enrollment and dedicated service identity; enforced **signed and tamper-protected** App Control for Business base+supplemental policies with **UMCI** explicitly enabled. Avoid path-only or broadly signed publisher/issuer rules, user-writable policy files and arbitrary process path parameters.

**Protected publication:** Privileged installer stages a versioned flat executable under a SYSTEM/service-owned NTFS tree with pinned file/ancestor SIDs, DACLs and owner, with symlinks, junctions, hardlinks, ADS, replacement grants, preexisting writable-handle/mapping and race cases explicitly checked. Verify the flat SHA256, strict expected signing chain/SPKI+EKU+revocation, identity and producer manifest using a held source handle; do not hand trust to a user-provided binary path. Treat cache-only revocation gaps as unavailable/denied and verify actual CRL/OCSP test cases separately; keep signature and trust diagnostics free of secrets.

**Process admission:** Trusted signed custodian opens and retains an exact released file with no write/delete sharing and protected directory handles, verifies `FileIdInfo`, invokes documented `CreateProcessW` with absolute `lpApplicationName` and `CREATE_SUSPENDED`, inspects process identity and MEM_IMAGE mapped name, ensures effective App Control policy enforcement for *actual execution*, and assigns kill-on-close Job Object **before** any resume. If any evidence is unavailable, terminate suspended process and return `DENIED`. Only release locks after durable process supervision and attested admission.

**Documented boundary:** `CreateProcessW` has no documented already-open executable `hFile` or `hSection` input. `QueryFullProcessImageNameW` and `GetMappedFileNameW` give *names*, not a kernel section object handle equivalence proof. FileIdInfo of a path reopened after creation is an additional check, not proof that the executable section bytes were the validated bytes. A signed custodian plus properly enforced WDAC/UMCI is defense in depth and demands independently demonstrated allow/deny execution on the target VM. Do not use undocumented native Nt* interfaces as a production guarantee.

**Auth API requirement to AI-03:** An authenticated, ACL-restricted local request carries `version`, nonce/id, authoritative `ownerId`, `deviceId`, monotonic `authorizationEpoch`, immutable `releaseId`, `tunnelId`, opaque protected credential reference. Never accept arbitrary executable path, caller-provided signer/hash approval, unrestricted environment or trusted-flag. Receipt must bind request+epoch+device to release flat SHA, signer/cert result, held FileIdInfo, **actual enforced policy evidence**, Job Object custody, PID + creation FILETIME, outcome `DENIED|ATTESTED_SUSPENDED|LAUNCHED|EXITED` and bounded rejection enum. These are **proposal fields only**; no receipt producer is deployed.

## VM-only adversarial acceptance gate

**Do not run on NAVEAX, Work-PC, or GitHub shared Windows runners.** Use a freshly snapshotted and isolated disposable Windows VM with independent user and SYSTEM/service SIDs, an approved signed policy and recovery path, and no live Cloudflare credentials.

1. Capture the VM snapshot and per-policy signed identity, active base and supplemental policies, UMCI option and enforcement mode. A CiTool policy count or audit-only 3076 must not count as enforce.
2. Execute a known approved pinned Cloudflare fixture and an unsigned/wrong-publisher/wrong-version signed fixture under the *actual* policy, with expected allow/deny and no fallback launch; capture process creation and CodeIntegrity Operational 3077, correlate 3089 by ActivityID. 3077 is enforced block, 3076 audit-only. Without the matching enforced block, gate = BLOCKED/FAIL.
3. Repeat symlink/junction/parent replace, hardlink, ADS, rename between SHA and process admission, writable handle pre-open and **writable memory mapping created before source handle lock**, cross-SID/foreign ACE/owner, malicious DLL load, revoked signer/expired chain and revocation-cache outage. For each case record denial stage and whether any process ever ran; a source re-hash after a late mutation is not by itself proof if the process has already resumed.
4. Verify no child resumes before successful image-admission evidence, no orphan on failed job assignment/custodian crash, no token disclosure, and no replacement after privileges drop; run reboot/rollback and signed-policy recovery in the VM.
5. Restore snapshot and confirm no policy, signed launcher or credential modifications to physical devices. Capture exact SHA of every tested source/fixture, policy ID/version, OS build, event ActivityIDs and job IDs. Any missing proof remains NO-GO.

Do not assume the existing unsigned `native/windows-cloudflared-image-probe.c` is a production launcher; it remains **disposable and always terminates suspended processes**.

## Final gate and AI-05 handoff

- #1077 owns P1-A/B/D and the exact blobs listed above. #1089 already has all three relevant blobs, no additional product-code cherry-pick required from the pre-addendum source HEAD.
- #1089's Windows lifecycle Job Object implementation passed its exact-SHA regression. Treat that as lifecycle acceptance only.
- The **execution provenance, enforce-scoped UMCI, certified native launcher and independent VM tests** still have no valid production evidence. Both #1077 and #1089 stay Draft/NO-GO for Windows Cloudflared launch; no main merge or production feature flag change is authorized by this report.

References:
- https://learn.microsoft.com/en-us/windows/win32/api/wintrust/ns-wintrust-wintrust_data
- https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw
- https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/operations/event-id-explanations
- https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/operations/appcontrol-debugging-and-troubleshooting
