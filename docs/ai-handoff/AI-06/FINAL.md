# AI-06 teslimi

- **Karar:** `READY_FOR_REVIEW` (kaynak + sentetik negatif regresyon) / **Production CORE `NO_GO`**.
- **Branch:** `ai/06-console-claim`.
- **Draft PR:** https://github.com/Naveax/Nexowire/pull/985
- **İlk test HEAD SHA:** `f958e4136a4e1378c2279efe9e29436bf3adbcf2`.
- **Base SHA:** `7e4093c30c1ead3cd22888184450c34aef4737da` (#980; #951 düzeltmesini içerir).
- **Değişen izinli dosyalar:** `src/product/d1-core-console-authority.ts`, `test/ai06-consent-claim-races.test.ts`, `docs/ai-handoff/AI-06/STATUS.md`, `CONTRACT.md`, `INTEGRATION_REQUEST.md`, `TEST_EVIDENCE.md`, `FINAL.md`. Mevcut testlerin negatif beklentileri silinmedi veya gevşetilmedi.
- **CI run ID:** https://github.com/Naveax/Nexowire/actions/runs/41194595574; exact ilk HEAD; ilk gözlemde Node 22/24 ve macOS/WSL2/Linux/security PASS; Windows browser-live henüz sürüyor. Ek dokümantasyon commit'i yeni HEAD oluşturursa o SHA'nın CI kanıtı ayrıdır.
- **Negatif test sonuçları:** İlk 13 test Node 22 ve 24 CI'da **13/13 PASS**. D1 signing-key claim/status race + missing key ile toplam 16 test; son 3 testin exact source HEAD CI doğrulaması **henüz yok**. Hedef: post-await SPKI değişimini reddetmek ve missing-key status'ü fail-closed yapmak.
- **Komut/exit:** local `node --test --import tsx ...` ve `npm run typecheck` NOT_RUN (yerel repo/dependency ortamı yok); CI job SUCCESS. OS/sürüm ve sayılar TEST_EVIDENCE.md'de.
- **Mock / real OS:** sentetik `node:sqlite` + fixture signing; gerçek protected Win32 native authority/approval, OS-effect sınırı, iki-PC fiziksel kabul yapılmadı.
- **AI-02/03 interface:** `CONTRACT.md` ve `INTEGRATION_REQUEST.md`. Session PID/creation, interactive desktop/owner SID/LUID ve effect-boundary monotonic revoke kontrolü ayrı korunmuş native API'den gerekli; Agent JS readback tek başına atomiklik kanıtı değildir.
- **Açık P0 / risk:** native final OS readback-to-effect TOCTOU, gerçek onaylayıcı origin/publisher, rollback-independent ledger, gerçek Windows console session switch/logout/restart/lock, signed binary ve unattended revoke acceptance yok. AI-03 transport/AI-02 enrollment entegrasyonu koordinatörde.

**Yasaklara uyum:** Ana dala push, merge, tag, release, canlı Agent/Hub/Broker, UAC/ACL/DPAPI, D1/Cloudflare, token veya sahte consent oluşturma yapılmadı. CORE aktifleştirilmedi. Draft PR bağımsız AI-08 incelemesine hazır; gerçek native/physical kabul olmadan production NO-GO.

**Ek inceleme:** #985 üzerinde D1 signing-key rotasyonu sonrası stale claim/status yetkisi saptandı; izinli D1 dosyasında fail-closed düzeltme ve 3 yeni negatif vaka eklendi. Son HEAD CI doğrulanana dek `READY_FOR_REVIEW` ilk 13 testin kanıtıdır, yeni düzeltme için `IN_PROGRESS`. Production NO-GO değişmez.

- **İlave provider düzeltmesi:** `WindowsCoreConsoleProvider.execute`
  için kuyruk/async öncesi derin JSON snapshot; `core-console-provider.integration.test.ts`
  içinde mutation-negatif testi. CI doğrulaması yeni HEAD'e aittir.
- **D1 ek P0:** Claim'in native readback onayı henüz gelmeden
  `complete(succeeded)` kabul edebilmesi riskinin çözümü mevcut
  SQL CHECK/operation migration sınırı dışında. Koordinatör ve AI-03'e
  `INTEGRATION_REQUEST.md` üzerinden native-verified claim marker
  talep edildi. Bu risk production NO-GO nedenidir.

## Son çalışma: geç STOP ve oturum/readiness yarışları

- Kaynak: `src/agent/windows-core-console-provider.ts`, son asenkron
  STOP/blocked okumalarından sonra iptal tekrar değerlendirilir; native
  callback öncesinde STOP ve volatile iptal yeniden kontrol edilir.
- Test: `test/core-console-provider.integration.test.ts` geç iptalin
  native callback'e ulaşmadığı fixture; `test/ai06-consent-claim-races.test.ts`
  owner credential/re-pair ve `deviceStatus` readiness/session/revoke yarışları.
- **Yeni exact HEAD CI henüz doğrulanmadı.** Bilinen önceki HEAD
  `33fdc91ffbb41ad69183ab0a93b2a3cdf146a15e` için Node22/24
  17/17 AI-06 testi PASS idi. Bu bilgi yeni kaynak için PASS değildir.
- Açık P0, schema-native claim/complete onay işaretleyicisi ve protected
  OS effect boundary; `INTEGRATION_REQUEST.md` içinde ayrı, production NO-GO.

## Ek tamamlanma-ACK yarışı

`src/agent/windows-core-console-provider.ts` içinde native efekt
sonrası `complete` gönderiminden önce ve ACK sonrasında STOP/abort/
revoked/closed kontrolü eklendi. Yerel settlement I/O sonrasında da
değişen durum yeniden denetlenir. Tamamlanma ACK anında iptal testi
`test/core-console-provider.integration.test.ts` içine eklendi.
Uzak D1 `succeeded` yazmış olabileceği için sonuç terminal UNKNOWN
olarak yerelden fence edilir; gerçek OS-native effect atomikliği veya
koordinatör migration'ı sağlanmış değildir. Production CORE NO-GO.

## Enrollment aktivasyonu için nesil-fence düzeltmesi

`WindowsCoreConsoleProvider.enroll` uzaktan gelen geç kayıt ACK'sinin
iptal veya eşzamanlı revoke sonrasında `revoked=false` yapmasını
engellemek üzere `stopSequence` ve nihai kontrol kullanır. İptalde
persisted STOP/revoke uygulanır. İki sentetik adversarial test eklendi.
Protected native consent origin, OS-effect atomik revoke ve D1
claim/complete native-verification marker hâlâ açık P0'dır.

## Premature complete audit-fence takibi

AI-06 sahipli D1 claim catch, native DENY/UNKNOWN sonrası yarışla
erken tamamlanmış `succeeded`/`denied` satırını `unknown` yapar;
kazanan/kaybeden ayrımı aynen korunur. Aynı request ID terminal kalır.
Yeni sentetik negatif test eklendi. **Kritik P0 hâlâ açık:** erken
`complete` yanıtını reddeden kalıcı native-verified claim marker,
koordinatörün migration/ledger değişikliğini gerektirir. AI-08 bağımsız
negatif test gevşetilmemiştir. Production CORE NO-GO.

## Controller-level revoke/enroll nesil-fence

AI-06 sahipli `src/agent/core-console-admission.ts` kaynak dosyasında
asenkron `enroll` sırasında gelen `revoke` için nesil kontrolü
ve `test/ai06-consent-controller-races.test.ts` testleri eklendi.
Yeni HEAD CI tamamlanmadan yeni testler PASS sayılmaz. Bu, native
signer/OS approval veya koordinatör migration P0 sorununu çözmez.

## Controller close/enroll kaynak düzeltmesi

`CoreConsoleAdmission.close()` artık controller state'ini yerelde
terminal durdurur; gecikmiş native approval controller'ı tekrar
açamaz. Tek controller altında eşzamanlı enrollment, tek pending
approval ile sınırlandırıldı. 2 ek sentetik negatif test eklendi;
mevcut STOP/revoke testleri korunur. Native OS onayı, gerçek owner
session ve effect-boundary CAS kanıtı değildir.

**WAL CI engeli:** `fc30dbd1448de5e502fafab59cd68ace16cd722f`
için Windows browser-live job `124545731212` AI-01/#974 journal
restart testlerinde 30s timeout verdi. AI-06 bu dosyalara dokunmadı.
Yeni kaynak HEAD exact CI'ı ayrı değerlendirilecek. Migration için
koordinatör Draft #996 gerekir; production CORE NO-GO kalır.
