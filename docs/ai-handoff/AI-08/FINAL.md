# AI-08 | Bağımsız QA teslim handoff

**Karar:** **NO_GO**, kaynak düzeyi güvenlik testi RED; Draft PR açık.
**Hedef:** 14 Kasım 2026. Bitiş tarihi güvenlik kabulü değildir.

| Alan | Değer |
|---|---|
| Repo | `Naveax/Nexowire` |
| Branch | `ai/08-independent-qa-20261031` |
| Draft PR | https://github.com/Naveax/Nexowire/pull/989 |
| Base SHA | `9d0f35607d4cde87bd031e2da77855cfaf570c31` |
| Son test edilmiş HEAD | `6004e2b44c8a5c5f9374a74498e98288e4d8f5cb` |
| Run | [41199793251](https://github.com/Naveax/Nexowire/actions/runs/41199793251), **FAILURE** |

## Ölçülmüş kaynak QA ve açık hata

- Node22 job `124533274467`: 2.805 total / 2.448 PASS / **1 FAIL** / 354 SKIP / 2 TODO. AI-08 **34 PASS, 1 FAIL**.
- Node24 job `124533274359`: CANCELLED, kısmi test logunda aynı AI-08 RED; final Node24 suite başarı iddiası **yok**.
- Diğer işlerin altısı SUCCESS, `browser-live` dahil; tüm workflow FAILURE.
- Tek RED: `test/ai08-console-claim.test.ts:135` sentetik in-memory D1'daki `claim` native readback beklerken ayrı imzalı `complete(succeeded)` başarılı kaydediliyor. Sonradan native readback DENY/offline, ancak işlem `succeeded` kalıyor.
- Yeniden üretim: `npm test` veya `node --test --import tsx test/ai08-console-claim.test.ts`. CI job exit code 1. Yerel komut bu turda çalıştırılmadı; CI doğrudan kanıttır.
- Bağımsız kanıt: [AI-08 P0](https://github.com/Naveax/Nexowire/pull/989#issuecomment-6543216588) ve [AI-06 handoff](https://github.com/Naveax/Nexowire/pull/985#issuecomment-6543216193). Koordinatör-owned schema migration ve AI-06 D1 state-machine, readback onayına bağlı tek kullanımlık marker gerektiriyor.

## Bu devam çalışması (henüz CI ölçülmedi)

`test/ai08-broker-receipt.test.ts` üç ek negatif test kazandı: imzası doğru ama foreign COMMIT ticket; final-native generation drift; final-native protected proof substitution. Aynı test dosyası, başka ajan source/test değişmedi. **Yeni HEAD / yeni CI sonucu GitHub PR'dan ayrıca doğrulanmalı; PASS/FAIL uydurulmaz.**

## Kanıtın sınırları ve nihai karar

- D1 = `SYNTHETIC_SQLITE`, Broker receipt/CAS = `SYNTHETIC_UNIT`, WAL = `DISPOSABLE_SQLITE`, mTLS = `LOCAL_TLS_LOOPBACK`.
- Gerçek owner UAC/DPAPI Windows Enrollment, native protected OS effect, token/job/AppContainer kernel isolation, rollback-independent CAS failover, iki-PC 24h ve entegrasyon HEAD **BLOCKED**.
- Dosya kapsamı: 6 `test/ai08-*.test.ts`, 5 `docs/ai-handoff/AI-08/*.md`. `src/`, `native/`, `cloudflare/`, CI, `main`, live Agent/PC değişmedi.
- PR yalnız Draft. Merge, deploy, release, physical attestation yapılmadı.


## 31.10.2026 | Independent enrollment cross-proof extension

- **Last measured QA SHA** `75060beef1cd025a1f9c893b5abeb07e86846e70` (CI [#41204359880](https://github.com/Naveax/Nexowire/actions/runs/41204359880)): COMPLETED **FAILURE**. Node22 **2,808 tests / 2,451 PASS / 1 FAIL / 354 SKIP / 2 TODO**, AI-08 **37/38 PASS**. Node24 job CANCELLED, but available test log shows identical full-suite counts and red D1 test. **Browser-live and all 5 other platform jobs SUCCESS** (6 SUCCESS / 1 FAILURE / 1 CANCELLED). No rerun was triggered.
- **New file in next commit** `test/ai08-enrollment-cross-proof.test.ts`: 6 additional independent negative tests using disposable ECDSA P-256 signing keys: signed session from another enrollment, validly signed wrong enrollment hash, foreign signature with matching scope, signer public-key pin substitution including internally coherent re-signed proof pair, strict `validUntilMs` expiry boundary and foreign Windows SID/session/LUID re-signing. Fixture proves only `SYNTHETIC_UNIT` protocol behavior. **These 6 tests are NOT_TESTED until their own exact-HEAD CI logs are verified.**
- **D1 P0 unchanged**: `complete(succeeded)` before native readback can persist as `succeeded` after rejected claim. Existing red regression is kept unchanged; source `src/product/d1-core-console-authority.ts` and migration are AI-06/koordinatör-owned. Until a real durable native-verified claim-CAS marker/commit gate is integrated and independently re-tested: **CORE production NO_GO**.
- **Acceptance boundary**: signed indefinite enrollment is not a protected native owner approval, device permission or effect permit. No live device, UAC, DPAPI, machine enrollment, kernel sandbox or actual offhost CAS was exercised. No merge/deploy/other-agent writes.
