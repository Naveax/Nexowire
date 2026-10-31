# AI-08 | Negatif test kanıtı (exact SHA/CI ayrımı)

## 31 Ekim 2026 | Kesin CI sonucu ve sonraki Broker negatifleri

**Bu bölüm aşağıdaki eski pending notlarından daha günceldir.**

- **Failing QA HEAD** `6004e2b44c8a5c5f9374a74498e98288e4d8f5cb`; matching [run #41199793251](https://github.com/Naveax/Nexowire/actions/runs/41199793251) **COMPLETED FAILURE**.
- Node22 job `124533274467` exit 1, `2805 tests / 2448 PASS / 1 FAIL / 354 SKIP / 2 TODO`, AI-08 `34 PASS / 1 FAIL`. Node24 job `124533274359` CANCELLED after corresponding new failure appeared in partial test log. Linux-native, local-enrollment-native, WSL2, macOS, security-operational and Windows browser-live SUCCESS.
- **P0 test** `test/ai08-console-claim.test.ts:135`: `complete(succeeded)` is accepted while native `currentReadback` remains pending, then readback DENY cannot tombstone `succeeded`. Actual `{acceptedEarly:true,stateAfterDeniedReadback:'succeeded'}`, expected `{acceptedEarly:false,stateAfterDeniedReadback:'unknown'}`. It is a reproducible `SYNTHETIC_SQLITE` source defect, **not physical Windows execution evidence**.
- **Fix owner:** AI-06 + coordinator-owned DB migration. New durable `native_claim_verified=0` default, atomic identity/epoch/READY/current consent check after independent readback, only then one-time marker, and `complete` must require marker=1; old unverified `dispatched` rows never eligible. No test skip or masking. See [handoff](https://github.com/Naveax/Nexowire/pull/985#issuecomment-6543216193).
- **Next AI-08 source change pending exact-HEAD CI:** 3 independent Broker receipt-negative tests: (1) validly signed foreign COMMITTED ticket, (2) final protected generation drift, (3) final protected Broker proof ID substitution. Expected all deny effect and replay. These tests have **NOT_TESTED** outcome until their own exact SHA CI completes. They do not replace the red D1 gate.
- The earlier 34/34 PASS belongs only to previous source SHA `13ea5e612942f9464ab88ab4e30d8d2974e813fe` (run `41198517077`). It cannot be inherited by current failing SHA or future commit.

---



## CI kanıt seviyeleri

### Doğrudan ölçülmüş AI-08 kaynak testleri
- **Kaynak HEAD:** `44f18a925974c9eb9743d366ded1d81ca851b95a`
- **Workflow:** CI, run ID `41194807179`, GitHub Actions `pull_request` (Draft #989).
- **Node 22:** `npm run typecheck`, `npm test`, `npm run build` **SUCCESS (exit 0)**; test suite `2787 total / 2431 PASS / 0 FAIL / 354 skipped / 2 TODO`; ilk **17 AI-08 testi PASS**.
- **Node 24:** `npm run typecheck`, `npm test`, `npm run build` **SUCCESS (exit 0)**; aynı 2787/2431/0/354/2, **17 AI-08 PASS**.
- **CI Node job IDs:** Node22 `124518726574`; Node24 `124518726530`.
- **WAL gerçek fixture geometrisi:** SQLite tarafından üretilen `2 current-generation / 161 prior allocation frames`. Önceki gerçek kullanıcı vakasının 709/295 sayısını fiziksel olarak tekrar ettiğimiz iddia edilmez.
- **Diğer CI job'lar:** Linux native, local enrollment native, WSL2, macOS, security-operational işleri önceki HEAD için SUCCESS görüldü. `browser-live` tam işin final sonucunu doğrulamadan tüm-run SUCCESS denmez.

### Daha sonra eklenen D1 claim/admission negatifleri
- **Kod commit:** `913230d378d9331eab01d7bb36094123d4fbe107`.
- **Test dosyası:** `test/ai08-console-claim.test.ts`. Offline, admin-bridge not-ready, privilege downgrade, platform switch, CORE disabled senaryoları. Her birinde async native readback sırasında D1 güncellenir; claim yanlışlıkla sürdürülmemeli; tüketilmiş request ID unknown/terminal kalmalı.
- **Bu ek testlerin ölçüm durumu:** `NOT_TESTED` bu doküman yazılırken. Commit `913230d...` için yeni run ID `41195396312` pending gözlendi. Nihai docs HEAD'in gerçek run'ı ayrıca doğrulanacaktır.

## Referans PR exact-SHA kanıtları (AI-08 testleri yerine kullanılamaz)

| Alan | PR / durum | exact HEAD | CI run | Sonuç |
|---|---|---|---|---|
| v1.0.8 main WAL candidate | main | `a19a228dc6f19fd484cf935e941a00ea625233f8` | `41078541065` | SUCCESS; physical CORE değil |
| External CAS nested request | #946 Draft | `00330e83e6fd4cf59d86bbbda3fb7c213f258ee4` | `40674859833` | **FAILURE: 3 adversarial** |
| Immutable CAS source fix | #947 Draft | `49109b082f811174894bf268ae1e57dbb2bea50d` | `40698276841` | SUCCESS |
| Broker signed receipts | #950 Draft | `4c92f676c5d0ce0dd6c85a6288912ab21bf4a80c` | `40752196776` | SUCCESS |
| Windows mutation dispatcher | #916 Draft | `0b505e053cb99704015700faf47c9c437862abef` | `40705681126` | SUCCESS |
| Console D1 race adversarial | #949 Draft | `2829db965bee48312e4614cd234caf34e7de24d4` | `40705928887` | **FAILURE: 6 adversarial** |
| Console D1 race source fix | #951 Draft | `169186b90a51619d79ff29a93a1770f4a9d4bdf2` | `40712106650` | SUCCESS |
| #07 OS sandbox provider | #859 Draft | `68ee74ce7e1e5a36c8ae2f9b065f49a5cb13cee9` | `40547392793` | SUCCESS; deny-only stub |
| mTLS source client | #982 Draft | `5e52b756cc6959ffacb7bcd25f2fc1ad2beccc39` | `41139860087` | SUCCESS; source/loopback |
| Integration candidate | #980 Draft | `7e4093c30c1ead3cd22888184450c34aef4737da` | `41113730982`, `41113730994` | SUCCESS; NO_GO |
| QA source base | #984 Draft | `9d0f35607d4cde87bd031e2da77855cfaf570c31` | `41145160595` | SUCCESS; AI-08 testlerini içermez |

## AI-08 negatif matris

| Negatif senaryo | QA dosyası | Ölçüm sınıfı | Kanıt (44f18...) |
|---|---|---|---|
| WAL RESTART/recycle, UNKNOWN korunur | ai08-wal-recycle | DISPOSABLE_SQLITE | PASS |
| Current WAL checksum damage, index header mismatch | ai08-wal-recycle | DISPOSABLE_SQLITE | PASS |
| Revoked owner, SID, machine, boot/session freshness | ai08-enrollment-sandbox | SYNTHETIC_UNIT | PASS |
| Server SPKI mismatch, immutable origin/redirect refusal | ai08-mtls-pin | LOCAL_TLS_LOOPBACK | PASS |
| Signed receipt scope/capability mismatch, COMMIT ACK loss | ai08-broker-receipt | SYNTHETIC_UNIT | PASS |
| CAS deep request identity mutation, signed scope substitution | ai08-cas-scope | SYNTHETIC_UNIT | PASS |
| D1 claim readiness loss during async native readback | ai08-console-claim | SYNTHETIC_SQLITE | NOT_TESTED on 44f18...; test later committed |
| Fake native sandbox attestation, hostile getters, UNKNOWN replay | ai08-enrollment-sandbox | SYNTHETIC_UNIT | PASS |
| Actual handle/env inheritance, descendant breakout, network/IPC, revoke drain | #07 native OS handoff | ISOLATED_NATIVE_OS | BLOCKED |
| Two physical PCs: true owner UAC/DPAPI/CORE 24h, reboot/sleep | owner-controlled staging | PHYSICAL_TWO_PC | BLOCKED |

## Yeniden çalıştırma
```bash
node --test --import tsx test/ai08-*.test.ts
npm run typecheck
npm run build
```
**Doğrudan elde edilmiş Node test exit code:** 0 (17 testli `44f18...` HEAD). Yeni D1 test ve nihai PR HEAD sonuçlarını ayrı exact SHA/run ile doğrula. Shell wildcard expansion platformu farklıysa `npm test` CI doğrulanmış alternatifidir.

**NO_GO:** `SYNTHETIC_UNIT`, disposable SQLite, localhost TLS, hosted Windows runner sonucu gerçek Windows owner-consent/TPM/mTLS production, native sandbox kernel isolation veya 2-PC physical acceptance değildir. #974 WAL P0, #539 reliability açık kalır.


## 31 Ekim 2026 · exact-SHA AI-08 güncellemesi (önceki pending notlarını geçersiz kılar)

- **Test kodu HEAD:** `9feb149e1b2723bb4609d21e4167824e400e9b85` (parent `21ea657db668ed90157ea42605b7c8de87563c8b`). Draft PR [#989](https://github.com/Naveax/Nexowire/pull/989), base #984 `9d0f35607d4cde87bd031e2da77855cfaf570c31`.
- **Exact CI:** [#41196966679](https://github.com/Naveax/Nexowire/actions/runs/41196966679). Node 22 job `124525116348`: **SUCCESS**, independent AI-08 32/32 PASS; Node 24 job `124525116481`: **SUCCESS**, independent AI-08 32/32 PASS. İkisinde de `npm run typecheck`, `npm test`, `npm run build` exit 0.
- **İki Node suite:** her biri 2.802 test, 2.446 PASS, **0 FAIL**, 354 SKIP, 2 TODO. Bu 354 SKIP eski suite toplamıdır, yeni 32 AI-08 testi skip edilmedi.
- **On adet yeni negatif:** D1 claim'in async native readback penceresinde owner epoch, grant generation, revoke epoch, enrollment ID, native receipt ID, Windows SID, session ID, logon LUID, Windows session epoch ve SAFE erişim moduna geçiş. Her senaryoda claim `CORE_NATIVE_CONSENT_SESSION_CHANGED` ile reddedilir, tüketilmiş request ID `unknown` terminal kalır ve tekrarlı claim doğrulayıcıyı ikinci kez çalıştırmaz. Kod: `test/ai08-console-claim.test.ts`.
- **Windows browser-live:** son tam sorguda workflow hâlâ `in_progress` idi; bağımsız Windows işinin final sonucu doğrulanana kadar workflow geneli SUCCESS sayılmaz. Bu dokümanları güncelleyen yeni commit için CI ayrıca **yeni exact HEAD** üzerinde ölçülmelidir.
- **Kanıt sınıfı:** D1 testleri SYNTHETIC_SQLITE (gerçek ürünün source-level D1 API'si, sentetik native readback), WAL DISPOSABLE_SQLITE, mTLS LOCAL_TLS_LOOPBACK, diğerleri SYNTHETIC_UNIT. **Gerçek OS sandbox isolation / native owner UAC / kalıcı fiziksel enrollment / iki-PC 24h kabulü BLOCKED; CORE production NO_GO.**
- **CI tekrar politikası:** mevcut active `(workflow, SHA, inputs)` run'ını yeniden dispatch etme; her rapor aynı exact SHA/run'a bağlanır. Eski iptal edilmiş run'lar FAILURE diye yeniden sınıflandırılmaz.


## 31.10.2026 | Yeni bağımsız QA testleri (CI sonucu henüz ölçülmedi)

Aşağıdaki üç ek test yalnızca AI-08 dosyalarına hazırlanmıştır; **bu kodun yeni exact SHA için CI sonucu henüz mevcut değildir**. Önceki `e30b3fe39cd74dc279b32a7e5ed1691d4cd7d591` HEAD'inin 32/32 PASS kanıtı yeni testleri kapsamaz.

| Yeni test | Kaynak dosya | Kanıt sınıfı | Durum |
|---|---|---|---|
| Transport-owned Broker receipt imzalı snapshot sonrasında owner/capability değiştirir; doğrulayıcı değişmez kopyayı kullanmalı | `test/ai08-broker-receipt.test.ts` | SYNTHETIC_UNIT | NOT_TESTED (yeni HEAD) |
| Aynı UUID ile ilk CAS reserve beklerken ikinci bağımsız admission başlatılamaz; tamamlandıktan sonra replay reddedilir | `test/ai08-cas-scope.test.ts` | SYNTHETIC_UNIT | NOT_TESTED (yeni HEAD) |
| Önceden iptal edilmiş mTLS isteği protected payload'ı yerel HTTPS endpoint'ine göndermemeli | `test/ai08-mtls-pin.test.ts` | LOCAL_TLS_LOOPBACK | NOT_TESTED (yeni HEAD) |

**Gerçek OS izolasyonu / Windows native consent / offhost CAS / physical two-PC kabul** için yeni testler dahil hiçbir sentetik PASS kullanılmaz. Üretim CORE NO_GO'dur.

### Bağımsız owner-PR exact HEAD / CI gözlem matrisi (31.10.2026 anlık görünüm)

| Modül | Draft PR | Gözlenen exact HEAD | CI run / son gözlem | AI-08 mock kaynak negatifleri | OS/physical |
|---|---|---|---|---|---|
| AI-01 WAL | #986 | `f33bc494fe4efe2a75d5a4a91917661afba8fa4b` | `41197139627`: 6 completed SUCCESS, browser-live aktif | WAL current/old suffix + current corruption PASS eski AI-08 SHA | BLOCKED |
| AI-02 enrollment | #984 | `9d0f35607d4cde87bd031e2da77855cfaf570c31` | `41145160595` SUCCESS | revoked owner/SID/machine/session synthetic PASS | BLOCKED |
| AI-03 mTLS | #988 | `a1cea7e58a853d9e598477e0f2efd64a65c361f5` | `41197111450`: 6 SUCCESS, browser-live aktif | Local wrong SPKI pin PASS; pre-abort yeni test NOT_TESTED | BLOCKED |
| AI-04 Broker | #987 | `62f73e1ddfa4c7fc8ebadcd7b7499393a66cc380` | `41196171288`: 7 jobs SUCCESS | signed receipt mismatch, lost-ACK PASS; transport tamper yeni test NOT_TESTED | BLOCKED |
| AI-05 CAS | #992 | `bc29cdc3a777e5c689b38c984626b4cf2becf2cd` | `41197355153`: 6 SUCCESS, browser-live aktif | signed scope, nested mutation PASS; parallel UUID yeni test NOT_TESTED | BLOCKED |
| AI-06 Console | #985 | `33fdc91ffbb41ad69183ab0a93b2a3cdf146a15e` | `41197159107`: 6 SUCCESS, browser-live aktif | 15 D1 readback readiness/scope negatives PASS (önceki HEAD) | BLOCKED |
| AI-07 sandbox | #990 | `237ad6d11317f93d032d3040d99b0936b9a16ea5` | `41197172377`: 6 SUCCESS, browser-live aktif | fake native permit, UNKNOWN deny PASS | BLOCKED |

Bu PR'ların yeni üretim deltalari AI-08'in #984 üzerine oturan test HEAD'inde **birleşik olarak yoktur**. Owner PR CI'sı başarı gösterse bile birleşik HEAD ve native kernel kabulü yerine kullanılamaz. Gözlem anındaki aktif işler için yeni final sonucu ayrıca aranır; bu tablo sonradan otomatik SUCCESS'e dönmez.


## 31.10.2026 | Bağımsız kanıt güncellemesi ve erken complete yarışı

### Doğrulanmış önceki exact-SHA Node CI
- **HEAD:** `13ea5e612942f9464ab88ab4e30d8d2974e813fe`, **run:** [41198517077](https://github.com/Naveax/Nexowire/actions/runs/41198517077).
- **Node 22 job:** `124529671456` SUCCESS; **34/34 AI-08 PASS**, full suite `2804 total / 2448 PASS / 0 FAIL / 354 SKIP / 2 TODO`; typecheck ve build başarılı.
- **Node 24 job:** `124529671427` SUCCESS; **34/34 AI-08 PASS**, aynı test toplamı, typecheck/build başarılı.
- Workflow `browser-live` bu rapor oluşturulurken `in_progress`: **tüm-run SUCCESS yazılmadı**. Bu SHA'dan sonraki yeni kod için sonuç **NOT_TESTED**, geçmiş SHA PASS devredilmez.
- Önceki bölümün `NOT_TESTED` dediği Broker transport raw mutation, CAS same-UUID concurrency ve pre-abort TLS kontrollerinin tamamı bu run içindeki Node test job'larında **PASS**. **Üç kontrol, iki yeni test vakası:** 32 -> 34 test.

### AI-08 D1 premature complete (yeni ve henüz ölçülmemiş)
- **Dosya:** `test/ai08-console-claim.test.ts`.
- **Üretim source incelenen HEAD:** `13ea5e612942f9464ab88ab4e30d8d2974e813fe` (PR #989 base #984). `src/product/d1-core-console-authority.ts:186-197` claim, bağımsız native `currentReadback` henüz beklenirken `reserved -> dispatched` yapıyor. `:219-224` `complete(succeeded)` yalnız `state='dispatched'` şartıyla sonuca geçebiliyor. `:166-169,213-217` readback reddedilirse yalnız `dispatched` state'ini UNKNOWN'a çeviriyor. Kaynakta bu üç adım arasında **yarış riski** var.
- **Gerçek yeniden üretim:** `node --test --import tsx test/ai08-console-claim.test.ts`; in-memory `node:sqlite` + iki imzalı request + bekletilen sentetik readback. Reserve, readback-pending claim, eşzamanlı complete(succeeded), ardından cihaz offline ve native readback'in reddi. `complete` erken kabul edilmemeli; reddedilen claim'in state'i `unknown` kalmalı.
- **Beklenen:** `{acceptedEarly:false,stateAfterDeniedReadback:'unknown'}`. **31 Ekim kaynak incelemesiyle olası fiilî:** `{acceptedEarly:true,stateAfterDeniedReadback:'succeeded'}`. **Yeni exact-HEAD test koşusu sonucu henüz gelmedi; bu satır gözlem değil kaynak çıkarımıdır.**
- **Kanıt türü:** `SYNTHETIC_SQLITE`; gerçek D1 transaction, native UAC, Win32 token ya da iki-PC kabulü **değildir**. Kırmızı sonuç varsa testi gevşetme veya `skip` etme; kapsam dışı migration/claim-state fix'i koordinatöre ve #06 sahibine aktar. **CORE production NO_GO**.


## 31.10.2026 | Independent enrollment cross-proof extension

- **Last measured QA SHA** `75060beef1cd025a1f9c893b5abeb07e86846e70` (CI [#41204359880](https://github.com/Naveax/Nexowire/actions/runs/41204359880)): COMPLETED **FAILURE**. Node22 **2,808 tests / 2,451 PASS / 1 FAIL / 354 SKIP / 2 TODO**, AI-08 **37/38 PASS**. Node24 job CANCELLED, but available test log shows identical full-suite counts and red D1 test. **Browser-live and all 5 other platform jobs SUCCESS** (6 SUCCESS / 1 FAILURE / 1 CANCELLED). No rerun was triggered.
- **New file in next commit** `test/ai08-enrollment-cross-proof.test.ts`: 6 additional independent negative tests using disposable ECDSA P-256 signing keys: signed session from another enrollment, validly signed wrong enrollment hash, foreign signature with matching scope, signer public-key pin substitution including internally coherent re-signed proof pair, strict `validUntilMs` expiry boundary and foreign Windows SID/session/LUID re-signing. Fixture proves only `SYNTHETIC_UNIT` protocol behavior. **These 6 tests are NOT_TESTED until their own exact-HEAD CI logs are verified.**
- **D1 P0 unchanged**: `complete(succeeded)` before native readback can persist as `succeeded` after rejected claim. Existing red regression is kept unchanged; source `src/product/d1-core-console-authority.ts` and migration are AI-06/koordinatör-owned. Until a real durable native-verified claim-CAS marker/commit gate is integrated and independently re-tested: **CORE production NO_GO**.
- **Acceptance boundary**: signed indefinite enrollment is not a protected native owner approval, device permission or effect permit. No live device, UAC, DPAPI, machine enrollment, kernel sandbox or actual offhost CAS was exercised. No merge/deploy/other-agent writes.
