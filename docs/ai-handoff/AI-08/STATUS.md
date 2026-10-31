# AI-08 | STATUS

**Durum:** `BLOCKED / REVIEW` (source-level independent QA; **CORE production NO_GO**).
**Güncelleme:** 31 Ekim 2026. Bu dosya gelecekteki commit SHA'sını önceden iddia etmez.

| Alan | Exact kanıt |
|---|---|
| Branch | `ai/08-independent-qa-20261031` |
| Draft PR | https://github.com/Naveax/Nexowire/pull/989 |
| Base #984 | `9d0f35607d4cde87bd031e2da77855cfaf570c31` |
| Son ölçülmüş QA HEAD | `6004e2b44c8a5c5f9374a74498e98288e4d8f5cb` |
| CI | https://github.com/Naveax/Nexowire/actions/runs/41199793251 (**FAILURE**) |
| Sonraki QA değişikliği | `test/ai08-broker-receipt.test.ts`: 3 yeni negatif; bunların exact new HEAD CI sonucu henüz **NOT_TESTED** |

## Son doğrulanmış sonuç

- Node 22 job `124533274467`: **FAILURE**, 2.805 test; 2.448 PASS / **1 FAIL** / 354 SKIP / 2 TODO.
- Node 24 job `124533274359`: **CANCELLED**; elde edilen kısmi logda aynı AI-08 güvenlik regresyonu RED.
- Windows `browser-live` ve diğer 5 iş: SUCCESS (son doğrulanan 8/8 iş durumunda 6 SUCCESS, 1 FAILURE, 1 CANCELLED).
- **34/35 AI-08 bağımsız test PASS**, tek RED: `complete cannot acknowledge success before native claim readback` (sentetik SQLite).
- Actual `{acceptedEarly:true,stateAfterDeniedReadback:'succeeded'}`; required `{acceptedEarly:false,stateAfterDeniedReadback:'unknown'}`. AI-06 + koordinatör SQL migration / persistent native-verified claim marker gerekir.

## CI sırasında bağımsız çalışma

Bu raporla aynı committe 3 Broker negatif test vakası hazırlanmıştır:
1. Doğru Ed25519 imzalı ama **farklı COMMITTED ticket** (ABA/ticket substitution).
2. Son korumalı native readback'te `generation` değişikliği.
3. Son korumalı native readback'te `protectedBrokerProofId` değişikliği.

**Yeni HEAD test sonucu: NOT_TESTED; geçmiş FAIL ve PASS'lar yeni SHA'ya devredilmez.** Güvenlik testi silinmedi, skip edilmedi. Mevcut active exact-SHA CI varsa tekrar dispatch etme; run ID takip et.

## Blokaj ve sahiplik

- AI-06/koordinatör: D1 claim pending iken complete success yazılmasını engelleyecek durable CAS / migration. [AI-06 P0 handoff](https://github.com/Naveax/Nexowire/pull/985#issuecomment-6543216193).
- Koordinatör: doğru bağımlılık zincirinde AI-01…AI-07 birleşik integration HEAD testleri.
- Ayrı fiziksel kapı: owner SID/UAC/DPAPI, protected Windows broker token, AppContainer/low-privilege kernel sandbox, handle/env/network/child/revoke, external rollback-independent CAS, 2-PC sleep/reboot/24h. Bunlar **BLOCKED**, sentetik PASS değil.
- Yalnız `test/ai08-*.test.ts`, `test/fixtures/ai08/**`, `docs/ai-handoff/AI-08/**` yazılır. Draft korunur. Merge/deploy/live device yapılmaz.


## 31.10.2026 | Independent enrollment cross-proof extension

- **Last measured QA SHA** `75060beef1cd025a1f9c893b5abeb07e86846e70` (CI [#41204359880](https://github.com/Naveax/Nexowire/actions/runs/41204359880)): COMPLETED **FAILURE**. Node22 **2,808 tests / 2,451 PASS / 1 FAIL / 354 SKIP / 2 TODO**, AI-08 **37/38 PASS**. Node24 job CANCELLED, but available test log shows identical full-suite counts and red D1 test. **Browser-live and all 5 other platform jobs SUCCESS** (6 SUCCESS / 1 FAILURE / 1 CANCELLED). No rerun was triggered.
- **New file in next commit** `test/ai08-enrollment-cross-proof.test.ts`: 6 additional independent negative tests using disposable ECDSA P-256 signing keys: signed session from another enrollment, validly signed wrong enrollment hash, foreign signature with matching scope, signer public-key pin substitution including internally coherent re-signed proof pair, strict `validUntilMs` expiry boundary and foreign Windows SID/session/LUID re-signing. Fixture proves only `SYNTHETIC_UNIT` protocol behavior. **These 6 tests are NOT_TESTED until their own exact-HEAD CI logs are verified.**
- **D1 P0 unchanged**: `complete(succeeded)` before native readback can persist as `succeeded` after rejected claim. Existing red regression is kept unchanged; source `src/product/d1-core-console-authority.ts` and migration are AI-06/koordinatör-owned. Until a real durable native-verified claim-CAS marker/commit gate is integrated and independently re-tested: **CORE production NO_GO**.
- **Acceptance boundary**: signed indefinite enrollment is not a protected native owner approval, device permission or effect permit. No live device, UAC, DPAPI, machine enrollment, kernel sandbox or actual offhost CAS was exercised. No merge/deploy/other-agent writes.
