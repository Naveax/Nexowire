# AI-06 | Test kanıtı ve sınırlar

**İlk test içeren exact HEAD:** `f958e4136a4e1378c2279efe9e29436bf3adbcf2` (PR #985).  
**Base SHA:** `7e4093c30c1ead3cd22888184450c34aef4737da` (#980).  
**Workflow:** GitHub CI `369213208`, **run #41194595574**, attempt 1; ilk kaynak HEAD'i üzerinde otomatik açıldı. Başka dispatch yapılmadı.

## CI ile doğrudan doğrulanan

- Node 24, job `124518109021`: **SUCCESS**, test toplamı `2752`, **2398 PASS / 0 FAIL / 352 SKIP / 2 TODO**. Yeni `AI-06:` önekli 13 testin 13'ü PASS. Typecheck, continuation ve build adımları başarılı (job SUCCESS). GitHub logundaki test özeti; yerel komut çıkış kodu olarak sunulmuyor.
- Node 22, job `124518109061`: **SUCCESS**, `2752` total, **2398 PASS / 0 FAIL / 352 SKIP / 2 TODO**. Yeni 13 test, 13 PASS. GitHub job exit sonucu: success.
- macOS job `124518108917`: SUCCESS.
- WSL2 job `124518109007`: SUCCESS.
- Linux-native job `124518109033`: SUCCESS.
- Security-operational job `124518109035`: SUCCESS.
- Windows browser-live `124518109143`: bu dosyanın ilk derlendiği gözlemde **in_progress**, final PASS iddia edilmedi.

## Kapsam: 13 sentetik regresyon

`test/ai06-consent-claim-races.test.ts`: 10 asenkron native readback esnasında D1 satırı değişimi, 1 readback DENY/locked/logout, 1 paralel kazanan/kaybeden claim, 1 tek-kullanım pozitif claim. Mutasyon sonrası `unknown` tombstone ve yeniden oynatılmayan request ID; duplicate loser'ın winner `dispatched` durumunu bozamaması.

Test fixture: `node:sqlite` bellek-içi D1 taklidi, sentetik Ed25519 test anahtarı, sentetik `currentReadback`. Native çağrı, UAC, fiziksel konsol, gerçek oturum, Windows servis, production Cloudflare/D1 ve gerçek owner consent hiç kullanılmadı.

## Komut kanıtları

CI'nin test keşfi yeni `test/ai06-*.test.ts` dosyasını otomatik çalıştırdı ve iki Node sürümünde 13/13 PASS raporladı. İstekteki doğrudan lokal komutlar bu oturumda **çalıştırılmadı**:

```text
node --test --import tsx test/core-console-admission.test.ts        NOT_RUN
node --test --import tsx test/core-console-provider.integration.test.ts NOT_RUN
node --test --import tsx test/qa-core-claim-readiness-race-p11.test.ts NOT_RUN
node --test --import tsx test/ai06-consent-claim-races.test.ts       NOT_RUN
npm run typecheck                                                   NOT_RUN locally; CI job PASS
```

Bunlar için **yerel exit code yoktur**; başarılı gibi sunulmaz. CI testleri Node 22 ve 24 Linux runners'ında doğrulandı. Windows gerçek OS readback sınıflandırması ve fiziksel user acceptance ayrı kapıdır. `CORE_EXECUTOR_DISPATCH_ENABLED=false`, `localEnrolled=false` ve physical consent NO-GO varsayımı korunur.

## AI-06 ek kaynak düzeltmesi ve henüz doğrulanmamış testler

İnceleme `D1CoreConsoleAuthority.handle('claim')` içindeki asenkron native readback sonrası kontrolün `public_key_spki` değişikliğini dışladığını gösterdi. `deviceStatus()` readback sırasında SPKI rotasyonunu da karşılaştırmıyordu. Yeni fail-closed karşılaştırma her iki yola eklendi. Ayrıca eksik public key'in `localEnrolled` oluşturması yasaklandı.

Yeni test sayısı: **16** (önceden CI PASS olan 13 + 1 claim-side signing-key race + 1 owner-status signing-key race + 1 missing-key status). Bu 3 yeni test ve ilgili production source fix için exact-head CI sonucu henüz yoktur, **PASS iddia edilmez**. D1 bellek-içi testinin gerçek protected signer veya OS oturum yetkisi olmadığını unutma. İlk HEAD #41194595574, sonraki doküman HEAD #41194860390 ayrı workflow/commit durumlarıdır. Yeni kaynak HEAD/CI kimliği PR ve Actions üzerindeki son commit üzerinden raporlanacaktır.

## Provider input/binding mutation regresyonu

`test/core-console-provider.integration.test.ts` içinde `AI-06:`
adlı yeni regresyon, `claim` sırasında çağıranın aynı input
nesnesini değiştirmesini ve native callback'in yalnız kabul edilen
orijinal snapshot'ı aldığını doğrular. Production callback değil sentetik
fixture; yeni exact HEAD'in CI sonucu bu dosyadaki eski PASS sayıları
yerine geçmedikçe yeni test PASS sayılmaz.

## İlave geç iptal ve kapsam yarışları

- Geç iptal regresyonu: `test/core-console-provider.integration.test.ts`
  `AI-06: late STOP-readback cancellation...` sentetik fixture ile son
  `store.blocked()` gözleminde AbortController iptali enjekte eder.
  Native callback **0** ve terminal `unknown` + STOP beklenir.
- `test/ai06-consent-claim-races.test.ts` içine claim sırasında owner
  re-pair + credential rotation ve `deviceStatus()` için yedi farklı
  asenkron online/platform/Broker/CORE/session/revoke yarışı eklendi.
- Güncel kaynakta **25 D1 fixture testi + 2 provider entegrasyon testi =
  27 AI-06 testi** beklenir. Yeni exact SHA'nın CI sonucu gelmeden PASS
  iddia edilmez. Önceki 17/17 PASS kanıtı yalnız
  `33fdc91ffbb41ad69183ab0a93b2a3cdf146a15e`, run `41197159107`
  için geçerlidir.

## Completion ACK sırasında iptal regresyonu (ek)

`test/core-console-provider.integration.test.ts` içindeki
`AI-06: abort during remote completion ACK...` sentetik fixture testi
native callback sayacını ve `complete` isteğinde araya giren
AbortController iptalini kontrol eder. Amaç: effect zaten meydana gelmiş
olabilir (`effects=1`), fakat uygulama geç iptalden sonra eski
başarı ACK'sini kullanıcıya döndürmemeli; STOP kalıcı olmalı,
yeniden kurulan provider aktif sayılmamalı ve request replay edilememeli.
Bu test yeni exact HEAD'in CI sonucu gelmeden PASS sayılmaz.

## Enrollment ACK / revoke yarışları

`test/core-console-provider.integration.test.ts` iki yeni sentetik
negatif vaka içerir: `enroll` HTTPS isteği sırasında AbortSignal
iptali, ve `clearStop` aşamasına eşzamanlı `revoke` girilmesi.
İkisi de `CORE_ENROLLMENT_CANCELLED_BEFORE_ACTIVATION`, yerel
kalıcı STOP ve yeniden oluşturulan provider'da `active=false`
bekler. Windows fiziksel kullanıcı onayı, üretim D1 ve gerçek mTLS
bağlantıları kullanılmaz. Bu yeni vakalar exact HEAD CI kanıtı
gelmeden PASS kabul edilmez.

## Erken complete sonrası native DENY terminal regresyonu

AI-06 D1 fixture'a, henüz bekleyen native readback sırasında ikinci
imzalı `complete(succeeded)` isteğini yarıştıran regresyon eklendi.
Native readback DENY sonrasında D1 operasyonu `unknown` kalmalı,
`claim` ve `complete` aynı UUID ile replay edilememelidir.
Eski kaynak, erken `succeeded` kaydını terminal başarıda bıraktığı
için bu negatif regresyondan geçemezdi.

**Kapsam sınırı:** Bu test erken `complete` için `acceptedEarly=false`
iddia etmez. Bu ayrı bağımsız AI-08 P0 testi (#989, failing QA) ve
koordinatörün migration/ledger entegrasyonu gelmeden geçmez.
Yeni AI-06 testi exact HEAD CI tamamlanana kadar PASS sayılmaz.

## Controller local STOP/enroll nesli regresyonları

Yeni `test/ai06-consent-controller-races.test.ts` üç sentetik vaka:
revoke ACK başarılı / hata durumlarında bekleyen `provider.enroll()`
true dönse de controller'ı açamama; gerçek bir STOP'tan sonra yapılan
**yeni explicit** enrollment'ın eski STOP'la karıştırılmaması.
Üçü de fiziksel Windows/native kayıt değil; yeni exact SHA için CI
sonucu yokken PASS iddia edilemez. Önceki 31/31 PASS yalnız
`790e83ba757ecc928b7af1d8fe4ac0cc389587ea` içindir.

## Controller terminal close ve single-flight enrollment regresyonları

`test/ai06-consent-controller-races.test.ts` iki ek sentetik negatif
vaka içerir:
- `close()` bekleyen onay sırasında çağrılır; eski provider true dönse
  bile controller kapalı kalmalı, yeni enroll reddedilmeli, ikinci close
  idempotent olmalı ve native callback hiç gerçekleşmemeli.
- Aynı controller üzerinde paralel iki onay isteğinden yalnız birisi
  provider'a ulaşmalı (`CORE_ENROLLMENT_PROMPT_ACTIVE`), asenkron
  işlem sonrasında kilit tekrar açılmalı.

Bunlar protected native consent, fiziksel Windows onayı veya OS effect
kanıtı değildir. Yeni HEAD'in CI sonucu gelmeden PASS kabul edilmez.

**Bilinen önceki HEAD `fc30dbd1448de5e502fafab59cd68ace16cd722f`:**
Node22/24 34/34 AI-06 PASS, total 2.773 / 2.419 pass / 0 fail;
Windows browser-live RED `124545731212`, iki AI-01/#974 WAL worker
30s timeout. Kapsam dışı testleri gevşetme veya yeni timeout oluşturma yok.
