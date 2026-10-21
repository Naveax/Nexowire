# P0 W26: native file handle provenance (independent negative QA)

**Status:** SOURCE-ONLY / TEMP-ONLY / DRAFT. **Do not merge or deploy as physical acceptance.**

## Reproducible provenance

- Repo: Naveax/Nexowire.
- Starting main commit: 754cc4364822be5fda528f54042fb22a84f19924.
- Independent QA branch: qa/w26-native-handle-provenance-20261021.
- Test: test/p0-native-handle-provenance-w26.test.ts.
- Related unmerged owner PRs: [#553](https://github.com/Naveax/Nexowire/pull/553) (filesystem/USB grants), [#634](https://github.com/Naveax/Nexowire/pull/634) (cross-device transfer). #634 is a child of #616 and does not make Agent 1.0.5 a trusted fenced native writer.
- The QA branch **does not edit** src/agent, src/mcp, native executables, native installer, Agent/Broker or any #05/#08-owned test.
- Tested in a dedicated cloned Windows TEMP worktree with npm ci --ignore-scripts and a per-worktree npm cache; no shared repository branch, production service, machine ACL, UAC, mounted USB, VM or user data was modified.
- Do **not** touch the unrelated ReVoltVPN-Ubuntu-Lab.

## Threat and fixture matrix

| Vector | Synthetic/native exercise | Acceptance expectation | Limits |
| --- | --- | --- | --- |
| Handle held across pathname rename/recreate | CreateFileW/GetFileInformationByHandle; rename/recreate under one disposable TEMP directory | Retained handle ID remains stable; reopened pathname has another ID; never use a pathname to claim handle continuity | Read-attributes-only probe; not a native mutation executor |
| Hardlink and alternate data stream (ADS) | NTFS disposable hardlink and named ADS | Two names can share one file ID; ADS is a distinct stream path and must be independently authorized | File ID alone cannot authorize arbitrary hardlinks/streams |
| Junction and reparse target | FILE_FLAG_OPEN_REPARSE_POINT on TEMP junction; separately inspect traversed child | Reparse handle is not the target handle; deny unexpected traversal/mutable path ancestry | Unsupported junction creation reports an explicit test skip |
| Scoped volume/owner/device grant | Pure negative authority oracle with owner, device, epoch, volume GUID, disk ID, partition ID, file ID, reparse | Any stale/missing/changed dimension denies | Synthetic identity only. Real USB identity and OS ACL/provider attestation **not** proven |
| Huge offset | BigInt simulated metadata at 256 MiB + 1 and above 4 GiB, including invalid > 2^53 and overshooting ranges | Preserve exact 64-bit-safe bounds; reject unsafe Number conversion/overflow/out-of-range | **Zero** 1 GiB allocations and no physical large-file I/O |
| Cancel after first bounded read | Deterministic async gate after 64 KiB, rename/recreate path, cancel, inspect original open handle | CANCELLED, no publication, original prefix digest verified from held handle | Node read fixture; does not prove physical Agent atomic cancel/publish |
| Lost write ACK / partial stage | Deliberate test-only one-write then lost ACK, independent staged readback, cancellation | MUTATION_UNKNOWN; no blind replay, no publication | No real Agent/Broker writer dispatch, no distributed CAS |

## Commands and precise local results

On isolated Windows x64 / Node.js v24.15.0, before this documentation-only commit:

    node --test --import tsx test/p0-native-handle-provenance-w26.test.ts
    npm run typecheck
    git diff --check

- Six tests: **6 PASS, 0 FAIL, 0 SKIP**. Both kernel32 native tests ran on Windows (not skipped).
- npm run typecheck: **PASS**.
- git diff --check: **PASS**.
- Test-only commit before this documentation: 7339c0b7393f9360c74f5c62ab3f5f5bc7b2a3bf.
- Hosted CI must be inspected **by the final PR HEAD SHA**. Never infer hosted PASS from local PASS or from parent PR CI. Linux/macOS deliberately skip the two Windows-native probes, but should still run the four platform-independent cases.

## P0 integration gates that remain blocked

1. #05 must bind a trusted Windows native handle, final path, file and volume identity, and the *current* owner/device/epoch/USB grant at the actual operating-system mutation. realpath followed by Node fs methods remains a TOCTOU gap. Junction reparse, hardlink and ADS must not bypass scope.
2. #05/#08 must provide signed, verified, atomically fenced Native writer/readback semantics with a durable external lease/epoch and fail-closed MUTATION_UNKNOWN, never replaying a possibly dispatched destructive write. A Hub assertion or synthetic Map/CAS is insufficient.
3. Real Agent 1.0.5 has not been changed here. Genuine physical >256 MiB read/hash/write, disconnected USB/reletter race, ACL and trusted code-signature/installed-Broker checks remain **BLOCKED**.
4. Owner review, integration #00, Windows source CI and separately authorized physical canary evidence are required before release. These QA tests alone are not a security boundary.

**Scope assurance:** No physical USB operations; no user files; no production permissions; no 1 GiB stage; no console focus or VM actions; no elevated shell or UAC.
