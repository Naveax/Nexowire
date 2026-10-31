# AI-02 | source delivery / production acceptance verdict

**Verdict:** SOURCE REVIEW CANDIDATE; **PRODUCTION NO-GO** until independent external trust and physical acceptance. Draft PR [#993](https://github.com/Naveax/Nexowire/pull/993) on `ai/02-enrollment-hardening-20261031`; stacked base #984 `9d0f35607d4cde87bd031e2da77855cfaf570c31`, unmerged.

## Delivered in AI-02-only paths

- Native Windows opt-in enrollment with signed persistent ES256-P1363 CNG machine-key grant; exact device, installation, owner account/SID, grant generation, service incarnation and Windows active physical console checks.
- Protected store owner/DACL validation, canonical external issuer SPKI readback, corrupted/revoked marker fail-closed, immutable consent and revoke evidence, bounded persisted one-use nonce ledger and process-crash-safe revoke-vs-attestation file-sharing fence.
- Local named pipe with remote clients refused, owner impersonation and active session readback, bounded v2 frames and generic denials. Native client additionally rejects unsigned/self-inconsistent `verified:true` envelopes and signed replies that do not match the **exact submitted authority challenge**. This proves internal cryptographic consistency only, **not independent pinned trust or execution authority**.
- Install/uninstall scripts: exact 2-device allowlist, manifest digest and runtime hash verification, owner/Agent identity comparisons (not independent authenticity), service identity and protected state checks. Installer requires **explicit `-Execute`**; `-PreflightOnly` is read-only; neither/both modes deny; uninstall likewise requires a separately reviewed and revoked `-Execute` path. No production installation performed.

## Exact-head evidence rule

Last source HEAD before this candidate: `4c2b379dd12c4b704d19e5804d83afae44dc10a7`, [CI #41246829570](https://github.com/Naveax/Nexowire/actions/runs/41246829570). At last observation, 7/8 jobs PASS and browser-live still in_progress; Windows native #124671948122 PASS with 0 .NET errors/warnings and 5/5 tests PASS, 192-file artifact `installed=false`. **This is historical:** the PR's new exact HEAD must be fetched live and its automatic workflow independently verified before considering a merge. Previously fully green `2fef25808393eb84232872507e2d316e9a23b327` / #41243991732 8/8 applies only to that earlier commit.

## Unresolved acceptance, not simulated

1. Coordinator P0: signed/protected Agent installation identity and race-safe same-owner native pipe peer executable provenance. Caller-selected `AgentIdentityFile` is not trusted authority.
2. AI-03 P0: independently pinned issuer/mTLS, monotonic off-device revoke and grant generation, durable one-use CAS plus final protected native readback at actual effect boundary.
3. AI-08 P0: adversarial tests and independent source review on **exact combined SHA**, including earlier D1 `complete(succeeded)` before native readback race. AI-02 cannot modify AI-06/Coordinator/QA files.
4. Approved disposable Windows acceptance P1: actual installed SCM lifecycle, crash/reboot, hostile pipe client, session changes, TPM hardware, owner physical consent, offline revoke and eventual two-PC staged checks. Source-only CNG tests are not real owner/SCM acceptance.

**CORE remains disabled; `mayDispatch=false`. No merge, deploy, live device, UAC/ACL or actual SCM modifications.**

## Next source review delta and acceptance caution
- Local owner dialog cancellation and additional IPC/installer spoofing regression fixtures are source-only. The native service still returns `mayDispatch:false`; the v2 ES256 machine grant is **not** the off-host v1 Ed25519 authorization. New source/test SHA's matching CI must be independently verified. Windows UAC cancellation, real ACL/access denied, RDP switch and protected live SCM operations remain NOT TESTED; production CORE NO-GO.
