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


## 1 Kasım 2026 | Yeni adversarial sandbox regresyonu

- **En son ölçülmüş QA HEAD**: `0b6a0a8a50f8c8c0b3b59fd2ab2951ea127e3c3c`; [CI #41207549485](https://github.com/Naveax/Nexowire/actions/runs/41207549485) **COMPLETED FAILURE** (Node22 2.814 / 2.457 PASS / 1 FAIL / 354 SKIP / 2 TODO; Node24 CANCELLED, log özeti aynı; Windows browser-live dahil 6 diğer job SUCCESS). **43/44 AI-08 PASS**; tek kırmızı native-readback-pending `complete(succeeded)` P0.
- **Sonraki kapsam-içi değişiklik**: `test/ai08-sandbox-escape.test.ts` ile 5 yeni negatif: imzalı-görünümlü all-green Win32/Linux/macOS report, privilege handle ve Job breakaway, ortam+ağ allowlist, hostile command getter, ACK-loss/UNKNOWN revoke-drain. Bu 5 testin exact yeni HEAD CI sonucu **NOT_TESTED**.
- Sahip AI-07'nin Draft #990 HEAD'i `4a31b5906fd62d7e97d9e1eddbbbcc0749595498`, exact CI [#41212601819](https://github.com/Naveax/Nexowire/actions/runs/41212601819) SUCCESS. #989 #984 tabanında olduğu için bu bağımsız AI-07 source deltalarını **içermez**. Gerçek kernel isolation ve combined integration hâlâ **BLOCKED**.
- D1 `claim/complete` P0 hâlâ üretim **NO-GO**. AI-06'nin güncel HEAD'i `033596d00b67e156d9c7696fc8ab71d21fd3de06` (CI #41211401246 SUCCESS) dahi `dispatched` işaretini native readback öncesi yazıyor; kalıcı native-verified CAS/migration owner gereksinimi değişmedi.


## 1 Kasım 2026 | D1 terminal claim ve UNKNOWN regresyon genişlemesi

- **Son ölçülmüş exact HEAD** `36be6880c35e47ed1697f55b39b1ec939ec6cfa8`, [CI #41243745899](https://github.com/Naveax/Nexowire/actions/runs/41243745899): Node24 job `124662799054` **FAILURE**, 2.819 test / 2.462 PASS / **1 FAIL** / 354 SKIP / 2 TODO. **48/49 AI-08 PASS**. Beş yeni sandbox negatifinin **5/5'i PASS**. Node22 job cancelled. Browser-live, Linux-native, macOS-agent-lifecycle, local-enrollment-native ve security-operational SUCCESS; WSL2 last observation **in_progress**. Workflow tamamlanmadan `completed` sonucu uydurulmaz.
- **Yeni pending QA HEAD değişimi** `test/ai08-console-claim.test.ts`: D1 terminal durumlarına dört bağımsız kaynak-negatif eklendi. (1) Eşzamanlı ikinci `claim` kazanan claim'i `unknown` yapamaz; (2) `complete` henüz `reserved` iken deny, normal sentetik claim'den sonra tek kez kabul; (3) native readback `false` => `unknown` + no replay / no late complete; (4) native readback exception/UNKNOWN => `unknown` + no replay / no late complete. Bu dört vaka ve tüm suite **yeni exact HEAD CI gelene kadar NOT_TESTED**; 49 -> 53 AI-08 test adayı.
- **Açık P0 korunur:** Native readback henüz pending iken `complete(succeeded)` kabul ediliyor ve ret ardından operation `succeeded` kalabiliyor. İlgili regression `test/ai08-console-claim.test.ts` fail olarak kalmalıdır. Koordinatör SQL migration + AI-06 source native-verified durable CAS gereklidir. AI-08 üretim/migration dosyaları değiştirmedi, hiçbir assertion silinmedi veya skip edilmedi.
- **Kanıt sınıfı:** `SYNTHETIC_SQLITE` ve in-memory Ed25519, gerçek D1/Win32 owner/UAC/DPAPI, off-host CAS, kernel sandbox veya iki-PC fiziksel kabul değildir. **CORE production NO_GO** ve Draft PR devam eder.


## 1 Kasım 2026 | #985 + #996 birleşik P0 kabul kapısı (AI-08)

- **Yetki sınırı:** AI-08 yalnız `test/ai08-console-claim.test.ts` fixture'ını değiştirir. #985 owner runtime ve #996 coordinator SQL dosyaları salt-okunur kalır. En son salt-okunur #985 source HEAD `d9dc636ebbabe7a82a5e34170da5e7517eeb22d4`, [CI #41247107420](https://github.com/Naveax/Nexowire/actions/runs/41247107420) SUCCESS. En son #996 migration HEAD `71286f47b11c6ba76ea59309c5a1aba4c3ea82dd`, [CI #41246389410](https://github.com/Naveax/Nexowire/actions/runs/41246389410) SUCCESS. **Bu ayrı CI sonuçları birleşik test değildir.**
- **Yeni AI-08 fixture entegrasyonu:** `0014`, `0015`, `0019`, `0020` yanında, mevcutsa resmi `0021_core_console_native_claim_verified.sql` migration'ı **aynı disposable `node:sqlite` test DB'sine** uygulanır. SQL kopyası oluşturulmaz, production migration değiştirilmez. Eski #984 bazında `0021` yoktur; asıl P0 `acceptedEarly=true` testi beklendiği gibi RED kalır.
- **Yanlış yeşili önleyen ek şart:** Orijinal `complete cannot acknowledge success before native claim readback` testinin `{acceptedEarly:false,stateAfterDeniedReadback:'unknown'}` assertion'ı **aynen korunur**. Bu assertion'dan sonra `HAS_NATIVE_CLAIM_MIGRATION===true` zorunludur. Böylece yeni #985 source tek başına eksik SQL kolonu yüzünden çağrıyı reddetse bile bu hata güvenli entegre acceptance olarak sayılmaz. Migration varlığı tek başına yeterli değildir; orijinal yarış testi ve diğer pozitif/negatifleri de geçmelidir.
- **Koordinatör için exact SHA işi:** #985 runtime + #996 resmi D1 `0021` migration + #989 tüm QA testlerini doğru dependency sırasıyla **tek integration HEAD** üzerinde birleştirip `npm run typecheck`, `npm test`, `npm run build`, Windows browser-live ve bağımsız D1 negatifleriyle ölç. Post-readback marker'ı yalnız current owner/session/READY + değişmez request bağında CAS set edilebilir; legacy default-0 satırlar `succeeded` olamaz; UNKNOWN/replay terminal kalır.
- **Ölçüm durumu:** Bu fixture değişikliği için yeni exact SHA CI henüz **NOT_TESTED**. Önceki QA HEAD `bb14213b43b127724875eadd170b2d9f5f9b28d1` [run #41246505285](https://github.com/Naveax/Nexowire/actions/runs/41246505285) Node24 job #124672088208 FAILURE, 2.823 total / 2.466 pass / 1 fail / 354 skipped / 2 TODO, **52/53 AI-08 PASS**; Node22 CANCELLED ama 4/4 yeni D1 negatifleri PASS. Windows browser-live önceki sorguda in_progress. **Geçmiş test sonucu yeni SHA'ya devredilmez.**
- **Kanıt sınıfı:** `SYNTHETIC_SQLITE`. Gerçek Cloudflare D1 migration deploy'u, korumalı native readback, Windows owner/UAC/DPAPI/TPM, external CAS veya iki fiziksel PC kanıtı değildir. **Draft / CORE production NO-GO**.


## 1 Kasım 2026 | WAL recycled-allocation integrity QA extension

- **Kaynak adayı:** `test/ai08-wal-recycle.test.ts` üç yeni bağımsız negatif ekledi. (1) WAL **header checksum** alanının bozulması, (2) SQLite tarafından tutulmuş WAL allocation son çerçevesinin **tek bayt torn/truncation** durumu, (3) ilk güncel çerçevenin salt alanının **eski allocation generation** ile değiştirilmesi. Üçü de `verifyAgentJournalWal` için `AGENT_JOURNAL_WAL_CORRUPT` bekler ve fixture'da DB + değiştirilmeyen SHM ve saldırganın bozduğu WAL byte'larının **yerinde korunmasını** ölçer; otomatik repair/truncate kabul edilmez.
- **Kanıt sınıfı:** `DISPOSABLE_SQLITE`. Yalnız `mkdtemp` + `node:sqlite` ile üretilmiş sentetik operasyon kayıtları kullanılır. Gerçek kullanıcı journal'ı, Agent, Windows servis veya fiziksel makina değiştirilmez. Bu üç yeni test için commit öncesinde **NOT_TESTED**; eski 53-case QA sonuçları yeni exact-HEAD'e PASS olarak taşınamaz.
- **Önceki ölçülmüş exact QA SHA** `49aab12e909930b249fed9494b40227245ba8568`, [CI #41248796078](https://github.com/Naveax/Nexowire/actions/runs/41248796078): Node24 `2.823 total / 2.466 PASS / 1 FAIL / 354 SKIP / 2 TODO`, AI-08 `52 PASS / 1 FAIL`. Tek kırmızı `complete(succeeded)` / native readback P0 korunur; #985 runtime + #996 migration + #989 QA entegre olmadıkça **CORE production NO_GO**.
- **Kalan ihtiyaç:** Koordinatör birleşik exact HEAD, gerçek native protected consent ve kernel sandbox/failover/2-PC kabulü. AI-08 yalnız izinli test/docs dosyalarında, PR Draft ve hiçbir duplicate workflow dispatch yok.
