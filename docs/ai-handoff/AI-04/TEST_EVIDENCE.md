# AI-04 TEST EVIDENCE — 31 October 2026

## Exact source-head CI
- Repository: `Naveax/Nexowire`; Draft PR #987.
- Source HEAD: `c5fb0e424cc30e2adaaa2dec9235d62eb6a4ce4d`; base `7e4093c30c1ead3cd22888184450c34aef4737da`.
- GitHub Actions: https://github.com/Naveax/Nexowire/actions/runs/41194719016.
- Event: pull_request; workflow `CI`; status **completed**, conclusion **success** (7/7 jobs). Per-job conclusions: Ubuntu Node 22 SUCCESS; Ubuntu Node 24 SUCCESS; Windows `browser-live` SUCCESS; `linux-native-live` SUCCESS; `security-operational-live` SUCCESS; `macos-agent-lifecycle-live` SUCCESS; `wsl2-live` SUCCESS.
- `npm run typecheck`: exit code **0** in CI (ubuntu and hosted Windows).
- `npm test`: exit code **0** in CI. Ubuntu Node 22 log: 2,744 tests; 2,390 pass; 0 fail; 352 skipped (and remaining are accounted for by suite structure, not physical acceptance).
- `node --test --import tsx test/ai04-broker-binding-snapshot.test.ts`: 5 subtests observed PASS in CI full Node suite on Ubuntu Node 22 and 24. These are disposable JavaScript witnesses, not OS authority.
- `node --import tsx scripts/qa-windows-broker-admission.ts`: exit code **0** in hosted Windows CI, 27 tests, 27 passed, 0 failed, 0 skipped. This is a disposable loopback/fake provider test, not installed protected Broker evidence.
- `./scripts/qa-windows-job-build-p11.ps1`: exit code **0** in hosted Windows CI (native Windows Job helper/MSVC guard compilation; fixture warning regression retains C4133 fail behavior).
- `node --test --import tsx --test-concurrency=1 test/windows-job-owner.test.ts test/windows-job-helper-trust.test.ts test/windows-job-helper-acl-publisher.test.ts test/windows-job-attestation-spoof.test.ts test/windows-job-duplicate-handle-risk.test.ts test/windows-job-breakaway.test.ts test/windows-job-hostile-nested.test.ts test/windows-job-named-handle-caveat.test.ts test/windows-job-capacity-128.test.ts test/process-manager-tree-cleanup.test.ts test/process-manager.test.ts`: exit code **0** in hosted Windows CI. **Not all kernel-negative cases passed**; see blocked cases.
- Environment for Windows job: Microsoft Windows Server 2025, OS `10.0.26100`, GitHub runner image `windows-2025-vs2026` dated `20261021.278.1` (hosted/disposable, **not** owner's two physical PCs).
- No local clone/test run in assistant container: GitHub hostname DNS unavailable, so local exit codes N/A. All test exit codes above are from exact-source-head hosted CI logs, not local commands.

## Windows evidence gaps that remain BLOCKED
- `real Windows SeDebugPrivilege LUID, token attributes and PrivilegeCheck agree`: source fixture PASS, but runner reported `BLOCKED: SeDebugPrivilege is enabled; equal-HIGH isolation cannot be accepted`. OS readback is real for the *runner self token*, not production Broker isolation.
- `after Job attestation, equal-HIGH same-logon PROCESS_DUP_HANDLE opens are denied`: **SKIPPED/BLOCKED**, `NX_MEDIUM_HIGH_PROOF_BLOCKED attacker_token_not_high_or_debug_enabled`.
- `real UAC-linked medium attacker cannot duplicate HIGH guardian Job handle`: **SKIPPED/BLOCKED**, `NX_MEDIUM_HIGH_PROOF_BLOCKED linked_token_unavailable`.
- Windows Job source states pre-seal duplicated-handle window remains P0 BLOCKED; runtime Job membership and provisional DACL readback do not close that window.
- Any real installed Broker publisher/ACL, owner-grant CAS, revocation fence, and all owner-PC physical acceptance: **NOT RUN / NO_GO**.

## Pre-existing immutable source references
- #950 source HEAD `4c92f676c5d0ce0dd6c85a6288912ab21bf4a80c`, run `40752196776` SUCCESS 7/7.
- #952 source HEAD `c6383530364ae7765982a988aed54d3c9a093752`, no PR-triggered run returned when inspected. Do not claim success for #952 exact head.
- #980 integration HEAD `7e4093c30c1ead3cd22888184450c34aef4737da`, run `41113730982` SUCCESS; its receipt source/test and Windows Job C/test blob hashes matched #950 and #952 respectively.
- A later docs-only HEAD must receive its own independent CI check; no rerun of the same SHA/workflow/inputs while active.

## New head pending after Windows handle-inheritance hardening
- New source: `native/windows-job-owner.c` restricts child inheritance to an explicit standard IO allowlist; new `test/ai04-broker-job-handle-inheritance.test.ts` has 2 source-only static negative tests.
- The previous 7/7 run applies ONLY to `c5fb0e424cc30e2adaaa2dec9235d62eb6a4ce4d`, not the new C changes. A new Windows native compile + Job launch/regression step on the new exact commit is mandatory; its results are pending at documentation authoring time.
- Even if compilation and Job tests succeed, equal-HIGH and medium-token physical evidence remain BLOCKED without independent kernel proof.
