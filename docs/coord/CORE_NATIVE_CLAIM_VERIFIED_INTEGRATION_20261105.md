# CORE native-verified claim: integration evidence and historical source index

**Updated:** 2026-11-05  
**Current stacked PR:** #1073, base #1067.  
**Source-only staging; production CORE remains NO-GO.**

## Historical documents retained without rewriting

- `CORE_NATIVE_CLAIM_VERIFIED_HANDOFF_20261031.md`, exact original Git blob `80ad0cac22105f8cf6fe11ca8cc89310d667fa0b` from #996/#1007; describes the independently reproduced early `complete(succeeded)` ACK attack, ownership, migration and required runtime CAS.
- `CORE_NATIVE_CLAIM_SAME_SHA_QA_20261101.md`, exact original Git blob `bcfc17a6d171a6654aeae9bc05ec948b5262e5e2` from #1007; describes historical exact-SHA adversarial test acceptance.

Their historical source SHA, base, PR and CI claims remain historical. **Do not interpret the older dates as a new or current release certification.**

## Current source lineage

- #1067 CORE staging HEAD `54d395d3c799a911021844dd11d232d290ddecd5` had exact-SHA CI 7/7 SUCCESS and Release Readiness 3/3 SUCCESS.
- #1073 original Native ACK source `e12e84f522d6294ea59c207cd6130b250e5191f0` had exact-SHA CI 7/7 SUCCESS on the former CORE base.
- #1073 merge candidate `f7a406e47e23ed7a8a513566bf00ad98d8012cde` is a two-parent merge with #1067. It retains eight Native ACK changed paths, `0021` migration, winning native readback CAS and negative tests. It also keeps main Scale S5 test gates.
- Source `0021` migration and `test/ai08-console-claim.test.ts` and `test/coord-native-claim-migration.test.ts` **evolved** from #996/#1007; these are not Git-exact replacements. Review their semantic deltas and never wholesale overwrite the current candidate.

## Current exact-SHA Windows acceptance blocker

CI [42095947457](https://github.com/Naveax/Nexowire/actions/runs/42095947457) at `f7a406e47e23ed7a8a513566bf00ad98d8012cde` finished **6/7 SUCCESS, browser-live FAILURE**. The failure was not a CORE `0021`/native-ACK assertion:

1. `test/windows-job-capacity-128.test.ts` failed during eight parallel disposable Job launches with `WINDOWS_JOB_KERNEL_ATTESTATION_FAILED: #< CLIXML`; the strict Win32 kernel attestation correctly refused unverified ownership.
2. `test/windows-job-owner.test.ts` fast-exit stdout/stderr-drain test exceeded its 28-second deadline under the same Windows runner.

These logs do not conclusively distinguish a transient Windows PowerShell resource-concurrency failure from a reproducible native helper defect. Do not change the Job's kernel check, relax 128-session/reclaim assertions, increase accepted timeouts without owner review, or claim overall CI PASS. Record failing job ID `127485893692` for targeted owner QA; require an independent disposable Windows runner reproduction with bounded process/PowerShell resource diagnostics.

## Required production acceptance

- Protected real Windows owner-consent witness and session readback, tested on disposable hosts
- D1 migration and Worker rollout as one coordinated one-way upgrade, no legacy terminal ACK reopening
- External irreversible mutation CAS and atomic effect admission across owner/device/epoch
- Lost ACK and UNKNOWN terminal integrity, duplicate contender must not tombstone winning claim
- Physical two-device reboot/re-pair/rollback and updated signed helper/ACL provenance tests

**Verdict:** Draft, NO-GO. No merge to `main`, production credential updates or physical device actions authorized by this document.
