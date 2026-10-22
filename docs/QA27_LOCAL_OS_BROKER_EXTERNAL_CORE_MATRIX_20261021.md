# P0 worker #27 | Local once-enrolled Broker vs remote owner authority

**Date:** 21 October 2026. Child source-only QA of [#684](https://github.com/Naveax/Nexowire/pull/684), exact parent `50632ee93b12b59b07da4dc16f9360687ae6ad60`. No owner implementation or CI workflow changes.

## Compared independent upstream branches

| Component | Exact source reviewed | Exact CI | Meaning |
| --- | --- | --- | --- |
| #684 UAC observation/assisted-result QA | `50632ee93b12b59b07da4dc16f9360687ae6ad60` | `39644577730` **SUCCESS (7/7)** | Source acceptance, not UAC or native Broker deployment |
| [#700](https://github.com/Naveax/Nexowire/pull/700) native process image / protected tree | `637ff3a6e8705e94e6ffba91790fd83329beee3f` | `39645643225` **FAILURE**, Windows job `119380363262` | 3 real failures in `test/core-broker-protected-tree.test.ts` verifying EXE/import/updater ancestor enumeration, replaced import/manifest handling and low-trust Modify on imported-module parent. Keep RED and investigate owner Win32/provider traversal. Node22/24 green does not erase hosted failure |
| [#702](https://github.com/Naveax/Nexowire/pull/702) external CORE dispatch authority | `576eab8926c8257c13a47fa1be806554e2ecd190` | `39646460335` **SUCCESS (7/7)** | Signed external permits and revoke-and-drain source + isolated TLS tests, **not** a deployed nonrollbackable remote CAS nor native elevated Windows Broker |

**Branch limitation:** #700 and #702 are distinct unmerged owner branches; neither production implementation is in the parent #684 tree. These *independent* QA fixtures express their composed security contract and exercise actual existing #684 observer/authorization APIs. They **do not claim** to run unmerged #700 or #702 code. Once merged, rebase and execute the untouched native tests and external CAS tests together on the resulting exact SHA.

## Local OS enrollment is not per-command consent

An authorized administrator completes a legitimate **OS-managed** Broker enrollment once. Local Windows authority must independently bind owner, device, approval request/session, exact signed publisher and image, effective token, and installer completion; mere process count, screenshot, HTTP health, CORE switch or a remote-helper acknowledgment is not proof. When a protected Broker is actually installed, later explicitly authorized operations **need not pop UAC per command**; every command *still* needs a live authenticated owner/device/session, owner/CORE epoch, exact capability and operation fingerprint, unrevoked external single-use CAS permit, and fresh Broker process security witness.

The owner may be physically absent during a **later command** if this ongoing delegation remains valid. Owner absent **during a new enrollment** plus a remote assistance session alone is insufficient proof of OS elevation. A separately authorized Remote Assistance/UIAccess *human credential entry* scenario could occur without a physical console grant, but still requires a genuine OS-attested elevation result. No automatic click, changing Secure Desktop, remote input impersonation, or UAC bypass exists in the source oracle.

## Acceptance/provenance matrix

| Case | Required evidence | Source-only outcome |
| --- | --- | --- |
| Local OS-approved one-time installation, signed protected Broker, owner absent later, current CORE epoch and remote permit | All independent Windows + external authority witnesses | **CONTRACT_CANDIDATE**, never "executed" |
| Owner absent at new enrollment, no local authenticated OS result | No native elevation evidence | **BLOCKED** |
| Remote Assistance/UIAccess session, claimed admin login but no independent OS result | Session authorization alone | **BLOCKED** |
| Forged `consent.exe`, screenshot or inaccessible Secure Desktop | Only read-only observation (`pending` or `unknown`) | **BLOCKED** for enrollment, never synthetic approval |
| #700 EXE, DLL, updater or ancestor ACL missing/writable | Independently complete signed import DAG, publisher and hash, protected ancestors | **BLOCKED** |
| PID reused, creation FILETIME mismatch, wrong file ID/volume/hash, low-priv duplicate-process-handle | Trusted actual running process witness | **BLOCKED** |
| Broker HTTP health but absent High token/Administrators enabled | Genuine token witness | **BLOCKED** |
| CORE revoked, stale owner epoch after re-pair, no authenticated session or revokeAndDrain pending | Fresh owner/scope from trusted external authority | **BLOCKED**, no re-UAC fallback |
| Remote CAS offline or lost ACK, native write may have begun | Independent reconciliation (or rollback-external monotonic witness) | **UNKNOWN**, no replay |
| Valid-looking signed claim for foreign owner, other device/session, stale generation, wrong fingerprint, expired/duplicated | Fresh single-use online external signed claim | **BLOCKED** |
| Healthy local OS enrollment **but** missing remote CAS claim | Separate per-dispatch authority | **UNKNOWN / BLOCKED**, no command |

### What QA proves and does not

`test/fixtures/qa27-core-broker-external-authority-contract.ts` is a strictly **test-only** classifier. Its synthetic green example returns `CONTRACT_CANDIDATE`, with invariant output:

- `realUacApprovalProven: false`
- `canExecutePrivilegedCommand: false`
- `submittedToBroker: false`
- `noPerCommandUacFallback: true`
- `safeToRetryUnknown: false`

The counterpart `test/qa27-local-os-core-external-authority-negatives.test.ts` exercises the existing `inspectWindowsUacStatus` and `explainDeviceAuthorization` source, plus adversarial permutations of #700 image/ACL and #702 external owner/CAS invariants. None of the booleans in a fixture is a real Windows ACL or verified external authority.

## Reproduce source-only CI

```bash
npm ci
npm run typecheck
node --test --import tsx test/qa27-local-os-core-external-authority-negatives.test.ts
```

No real Windows UAC, Secure Desktop input/settings, installer, live privileged Agent/Broker, VM, Cloudflare, remote CAS or protected user files are accessed. `ReVoltVPN-Ubuntu-Lab` is excluded. Maintain #700 red native test, #702 external-service deployment gate and #617 real Windows high-token/owner consent as **NO-GO** until independently proven.

## #780 P1 reviewed-diff / worktree grant vs OS authority matrix (22 October 2026)

**Status and provenance.** [#780](https://github.com/Naveax/Nexowire/issues/780) is an **OPEN P1 product epic**, not verified deployed functionality. Worker #27 inspected the actual #722 `src/security/authorization-explain.ts`, `src/security/privilege.ts`, `src/protocol/capabilities.ts`, and #767's `src/product/access-effective-authority.ts`, `access-queued-job-review.ts`, `access-final-dispatch-authority.ts`. Those modules currently distinguish read-only status, operation privilege requirement and source-level final grant, **not** a working reviewed-diff worktree executor. #767 `FINAL_SOURCE_CANDIDATE_ONLY`, `canLaunch:false`, `dispatchEffective:false`. No independently accepted HIGH-native Broker / atomic outside-host CAS exists. **The table below is a proposed acceptance policy, not a claim that a diff/worktree service already enforces it.**

| Dimension | SAFE | FULL | ROOT | CORE |
| --- | --- | --- | --- | --- |
| Account/capability policy | Safe-mode, non-elevated inspection and explicitly allowed read-only capabilities; deny mutations | Full-mode standard-user capabilities remain subject to capability-specific checks | Full-mode request **plus** authenticated owner, current login/session, ROOT lease with exact max **900,000 ms**, and explicit task scope | Full-mode request **plus** current owner/device/session, independently attested OS-approved once-enrolled signed protected HIGH Broker and live revocable CORE epoch/grant generation |
| Task/worktree scope | Read selected worktree and inspect proposed changes without modification | An independently issued exact taskId + device/owner + canonical worktree root + capability/path grant is required before mutation; outside-root path needs a separate explicit grant | The same task/path grant and verified ROOT lease; ROOT is **not** a wildcard to other worktrees, subprocess/network or Git hooks | The same task/path grant and independent live CORE grant; persistent CORE is **not** blanket worktree/secret/network permission |
| Diff preview/approval | View, reject, or propose changes only | Owner approval must bind base commit SHA, immutable diff SHA, allowed paths, taskId, worktree identity, requesting owner/device/session/epoch, operation fingerprint and TTL; recheck before apply | Diff approval **does not** mint or extend ROOT lease or allow arbitrary elevated operation | Diff approval **does not** prove Windows HIGH, native ACL, installed Broker, external CAS or authorize an elevated effect |
| Apply/rollback | Deny write/apply/rollback effects | Only after approved exact diff, fresh task grant, unchanged Git base/target SHA, worktree containment and independent reversible preimage; rollback only when verified safe | All FULL apply requirements remain, plus ROOT-specific live authorization **if** the operation actually needs elevation | All FULL apply requirements remain, plus CORE-specific live authority **if** an operation needs elevation; no per-command UAC after genuine bootstrap |
| OS HIGH elevation | Never | FULL itself is standard-user; capability such as `windows.service.control` is classified `elevated` and does not run on FULL alone | Genuine signed protected Broker native HIGH-token + PID/creation FILETIME/image FileID/SHA/parent/import/updater ACL/lowpriv AccessCheck, signed external current grant and atomic native effect fence | Same native/atomic effect requirements; additionally independently attested once-approved installation and unrevoked CORE owner epoch/grant generation |
| Failure or revoke | Fail closed | Stale diff/base, junction/symlink/outside-root, changed owner/task scope or Git hook escape => DENY; effect with lost immutable readback => UNKNOWN | Session logout/expiry, stale ownerEpoch/permit, revoke-start before native CAS commit => DENY; possible committed effect/ACK loss => UNKNOWN, no replay | Identical strict revoke-start, freshness, current installed signer and commit tests. `consent.exe` count, UIAccess or cached UI EFFECTIVE cannot restore approval |

**Independent authority layers, never interchangeable:**

1. **Task grant:** current, server-authenticated owner/device/session, exact taskId and canonical worktree root, allowed relative paths and capabilities, TTL, stable ownerEpoch; must be validated against symlinks/junctions, alternate roots, Git hooks and child process/network/secret access. A mere pathname guard is not an OS process sandbox.
2. **Diff approval:** explicit user consent for a specific immutable diff, Git preimage/base SHA, task/worktree and operation fingerprint; revocation, changed hunk, stale commit, wrong target or altered owner epoch invalidates it. Preview approval is **not** a privileged OS permission.
3. **Privilege requirement:** `privilegeRequirement(capability,input)` must be evaluated using actual arguments; e.g. `windows.registry.set` for HKCU is standard while non-HKCU is elevated; machine-scoped environment mutation is elevated. Capability presence in `CORE_CAPABILITIES` is only discoverability, not execution permission.
4. **Real OS elevation:** independently signed/enrolled protected Broker, actual HIGH token and enabled Administrators, running PID + creation FILETIME + file identity/hash, complete transitive DLL/updater signed tree, different restricted low-token effective ACL/PROCESS_DUP_HANDLE denial. Historical UAC approval, Remote Assistance session, screenshots or `consent.exe` count alone are insufficient.
5. **Dispatch authority:** separately signed **current** external commit grant bound to owner/device/session epochs, task capability, effect fingerprint, requestId, dispatchId, Broker native identity, original permitNonce and fresh finalNonce; `revoke-start` and native commit need one externally durable linearizable authority. Source readback or signed promise cannot replace native atomicity. Pending effect / lost ACK => `RECONCILE_REQUIRED`, no retry, no unjustified `drained:true` / COMPLETED.

### Required acceptance negative matrix, not a new test claim

| Condition | Expected result | Existing evidence or code owner |
| --- | --- | --- |
| SAFE mode receives diff `approve` and mutating `apply` | **DENY**; approval cannot elevate SAFE | #780 P1 diff/grant feature, **not yet verified implemented** |
| FULL approves SHA-matched diff within task root; write needs only standard token | Eligible **only** after explicit task/worktree + exact diff grants and OS filesystem checks; no HIGH claim | #780 P1 feature missing implementation evidence |
| Approval of diff then stale Git base, replaced file/hunk, outside-root symlink/junction or Git hook side effect | **DENY** before effect, no automatic hook execution | #780 P1 owner QA once code exists |
| Valid diff approval + expired ROOT lease or revoked CORE ownerEpoch | **DENY** elevated effect, even if UI says approved | Existing #719/#741/#757/#767 Access owner checks; no installed native executor |
| Valid diff approval + forged `consent.exe` / unverified local OS bootstrap | **DENY** new HIGH registration/dispatch | #684/#722 independent negative source QA |
| Correctly enrolled Broker + current CORE + in-scope task/diff + independent native HIGH and atomic external grant | **Eligible at contract level**, **no extra per-command UAC**; physical execution **NO-GO** now | #722/#767 source-only; #617 physical P0 gate |
| Valid signed CAS reservation/late permit but Hub B revoke-start wins before final external commit | **DENY**, zero native effects; signed status and diff approval irrelevant | #747/#764 simulated adversarial race, #722 composition QA |
| Actual effect may have committed but immutable outcome receipt/readback missing | **UNKNOWN / RECONCILE_REQUIRED**, never blind retry or fake rollback/completion | #764 source-only CAS test; #780 checkpoint requirement |

**No new independent executable negative was added by #27 in this review**: the P1 reviewed-diff/worktree apply code path itself is not verified as implemented, while the P0 forged approval, stale nonce/epoch, incomplete DLL/low-token proof and atomic commit/revoke composition negatives already exist. Implement actual diff/task-layer tests on the future owner feature branch once real source is available, without making synthetic candidate state into Windows privilege. This document is QA policy only; no Agent/Broker, UAC/Secure Desktop, protected files, ACL, VM or installed service was accessed.

## #787 source cross-review: approved patch is separate from native OS grant

**Review snapshot, 22 October 2026.** #787 DRAFT at exact HEAD \`3fe56ef39ab604a472974946dd31b4e016287f46\`, exact hosted [CI 39817200109](https://github.com/Naveax/Nexowire/actions/runs/39817200109) **SUCCESS**. It adds \`src/product/access-diff-approval-boundary.ts\` and \`test/access-diff-approval-boundary.test.ts\` on a **different unmerged Access owner branch**. The #722 source tree does **not** contain that new module. #787 validates a 60-second, signed \`LOCAL_USER_REVIEW_ONLY\` receipt and external epoch readback, but is only an intent review API: even all-good inputs yield \`APPROVED_SOURCE_ONLY_NO_MUTATION\`, \`effectiveElevatedPrivilege:false\`, \`nativeEffectVerified:false\`, \`canApply:false\`, \`canRollback:false\`, \`canLaunchElevated:false\`. It is **not** a Git patch engine, physical HIGH proof, final native CAS commit or a UAC approval.

| #780 reviewed-patch case | #787 source review vs required independent owner acceptance | Required fail-closed result |
| --- | --- | --- |
| Preview or an approved patch while SAFE | \`preview\` is read-only; a signed \`apply\` cannot grant mutation to SAFE. No task worktree executor exists on this branch | **DENY** mutation; no HIGH |
| FULL, approved diff with current exact base/diff digest | #787 compares both digests to server-current values, checks signed approval / owner / session / epochs; FULL does not call native HIGH projection | **SOURCE_APPROVED_ONLY**, not permission to apply; task/worktree/path enforcement must be separate |
| Approved patch but stale worktree HEAD, changed file/hunk, or reused approval | #787 verifies \`currentBaseSha256\`, \`currentDiffSha256\`, and consumed approval ID; it does **not** bind a canonical \`taskId\`, \`worktreeId\`, root, allowed paths, or native Git state. Equal digests in another worktree cannot imply same grant | **DENY** stale SHA/replay; **BLOCKED** until a real independently scoped worktree grant exists |
| Owner revoked / device re-paired / session rotated while reviewing | #787 reads external owner/device/session epoch and \`revoking\` **twice**, including after asynchronous effective authority checks; cached \`clientCoreEffective\`/\`clientApprovalGranted\` are ignored | **DENY** before effect; final external native commit must recheck independently |
| ROOT 900000 ms versus local review TTL 60000 ms | #787 review TTL is <= 60000 ms **not** a ROOT lease. ROOT status is delegated to \`AccessEffectiveAuthority.project\`, which has the separate ROOT ≤900000 ms lease and session requirements. Revalidate ROOT at *actual effect time*, not just at start of review | **DENY** exactly on ROOT expiry or logout; approval cannot extend ROOT |
| CORE **requested** vs genuinely OS-**enrolled** | \`corePreferenceEnabled\`, \`clientCoreEffective\`, signed local diff approval and Agent \`broker\` report cannot establish \`EFFECTIVE\`; #787 calls independent Access authority to check candidate, but the real installed HIGH signer/token is **not physically accepted** | **DENY** HIGH dispatch without physical Broker and fresh owner/CORE; no per-command UAC after real prior enrollment |
| Even a signed final CAS readback after approved patch | #775/#767 source final grant is \`FINAL_SOURCE_CANDIDATE_ONLY\`; #764's \`commitForDispatch\` is a TEST-ONLY simulated external linearizable authority. A diff review receipt is **neither** permitNonce/finalNonce native grant **nor** atomic commit | **DENY** native effect until independent physical signed Broker and actual externally serialized dispatch/revoke-start commit |
| Separate rollback approval while prior effect is UNKNOWN | #787 needs a distinct \`rollback\`-scoped signed approval and an independently verified prior \`COMPLETED_VERIFIED\` effect. The review does not itself perform rollback | **DENY / RECONCILE_REQUIRED**, no blind undo, no forged completion |

**Verified P0 CI provenance:** #722 pre-review HEAD \`4abdfad417bcb26bae6130e01c5c8fbaf11a514f\`, exact workflow [39816353334](https://github.com/Naveax/Nexowire/actions/runs/39816353334) finished **FAILURE**, with **Node22/24 + Linux/macOS/WSL2/security SUCCESS** and Windows \`browser-live\` \`Physical Windows Job Object regressions\` **FAIL**, stdout-before-\`exited\` assertion on **iteration 8**. This physical Job regression must remain RED; do not rerun or misstate as successful and do not blame docs or local diff-review source without evidence.

**Independent QA disposition:** #787 *does* have a real source-only \`reviewAccessDiffApproval\` method and existing negatives for stale base/diff, current owner epoch, simulated effective CORE, denied SAFE, and receipt replay. Adding identical QA27 tests to #722 would duplicate #787 and require importing a module **not present on #722's current base branch**. **No new executable negative on #722** until P1 task/worktree apply code and its owner-grant/provider integration exist. A distinct future test should assert a review signed for \`worktree A\` cannot authorize \`worktree B\` even when their base/diff digests match, and ensure ROOT validity is checked at final effect boundary. The current #787 schema lacks a worktree/task/root identifier, so a simulated passing test today would falsely certify an unimplemented grant. Keep P1 source QA separate from physical #271/#551/#587/#617 **NO-GO**. No UAC, Secure Desktop, Agent, VM, real Git mutation, protected OS path, or installed Broker access.
