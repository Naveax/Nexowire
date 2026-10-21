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
