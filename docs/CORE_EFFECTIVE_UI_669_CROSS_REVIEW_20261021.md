# Worker #23 | Source-only #642 vs #669 effective UI truth review

## Verified source revisions
- #642 exact reviewed SHA: `87644090113d21544f42a738d919d5422ed200c0`; hosted CI #39630395647 **SUCCESS** on final check (prior #39627064909 Windows Job failure was transient/inherited).
- #669 exact reviewed SHA: `99894af2c224d80ce4edeb71c1e98701f6c22ab8`; hosted CI #39632774193 **SUCCESS**. This branch is a DRAFT child of #621, **not merged or deployed**.
- #23 QA branch is a DRAFT child of #669. Only an independent test file and this document are added; no #04 Access implementation, web/app.js, native Broker, UAC, Agent or VM mutations.

## Evidence predicate comparison
| Gate | #642 UI prototype | #669 owner Access authority |
| --- | --- | --- |
| Requested CORE versus EFFECTIVE | Independent signed Broker + signed external epoch required | Server-side `AccessEffectiveAuthority.project` gates `EFFECTIVE` |
| Windows privilege | High native token, enabled Administrators and protected parent/import/task | Signed `nativeHighIntegrity`, Administrators, pinned publisher/release, parent/import/updater ACL and process-handle boundary |
| Image replacement | Exact independently expected Broker SHA and version | Exact SHA/version both in trusted reader and D1 current enrollment; same-version reinstall cannot reuse old signed image |
| Owner legitimacy | Owner, login session, owner epoch, generation | Authenticated current login/sessionHash, owner/device/credential, D1 enrollment, independent CAS high-watermarks |
| Expiration | 30-second synthetic proof; ROOT max 15 minutes | 15-second native and CAS proof; ROOT D1 login grant max 15 minutes |
| UAC appearance/HTTP401 | Ignored entirely | Signed local UAC bootstrap AND authenticated Broker required; `consent.exe`, listener and unauthenticated 401 are not proof |
| Reconnect | Signed `connectionEpoch` in v2 prototype | **No explicit per-reconnect epoch in #669 v1 signed statement**; owner login/session proof and short freshness still apply |
| Execution | `grantsExecution:false` | `canDispatch:false` |
| Browser badge | Output only; synthetic badge field deliberately ignored | `web/app.js` consumes server projection fields; never trust caller-supplied badge or snapshot flags |

## Independent #23 adversarial tests against **actual #669 class**
`test/core-effective-ui-669-negative.test.ts` tests:
- Recovered Broker after reinstall retains version but changes pinned SHA: old signed image never EFFECTIVE.
- Native medium/deny-only equivalent, unprotected publisher/ACL/process handle fail.
- HTTP 401 and Agent ready without authenticated protected native proof do not elevate.
- Stale `consent.exe` and forced green UI badge cannot substitute signed UAC approval or native HIGH token.
- Old signed owner epoch/generation after separately advanced CAS watermark fail.
- Forged signer, identical trust roots, revocation, offline and SAFE fail closed.
- Even synthetic all-valid status returns `canDispatch:false`.

Tests use generated local Ed25519 fixture keys only. They do **not** establish real protected Windows signer custody, physically trustworthy CAS, D1 migration, UAC approval or installation.

## P0 discrepancy for #04 owner
#669's native/external v1 statements lack the `connectionEpoch` that #642 v2 explicitly checks. A same-login, same-image, otherwise-fresh signed report after quick reconnect has no cryptographically bound connection incarnation in #669. This is **not proved exploitable with a live Broker**, but is a source-contract gap. Owner #04 should either bind authenticated device connection incarnation through independently signed native+CAS evidence, or furnish equivalent nonreplayable freshness proof; do not mark production CORE EFFECTIVE solely from a 15-second-old cached receipt after reconnect. This worker does not modify #04 files.

## Release result
Regardless of source CI success: production remains **NO-GO / BLOCKED** until independent native HIGH-token/publisher/protected image and external monotonic CAS are physically accepted; D1 and UI providers are not installed by this QA PR. No ReVoltVPN-Ubuntu-Lab interaction.
