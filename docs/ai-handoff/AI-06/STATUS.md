# AI-06 | Durum

**Durum:** IN_PROGRESS (source-only) / Production CORE: **NO-GO**.

- Repo: `Naveax/Nexowire`; branch `ai/06-console-claim`; Draft PR #985.
- Base exact SHA: `7e4093c30c1ead3cd22888184450c34aef4737da`.
- Son doğrulanan prior HEAD: `790e83ba757ecc928b7af1d8fe4ac0cc389587ea`; CI `41201296965` **7/7 SUCCESS**, Node22/24 31/31 AI-06 PASS.
- Mevcut önceki HEAD: `fc30dbd1448de5e502fafab59cd68ace16cd722f`; CI `41204160052` **6/7 SUCCESS**, Node22/24 34/34 AI-06 PASS, Windows `browser-live` RED (AI-01/#974 WAL worker 30 saniye timeout); CI gerçek FAIL olarak korunur. Doğrulama için Windows job `124545731212`.
- Bu geliştirme: `src/agent/core-console-admission.ts` üst düzey controller close/enroll yarışlarına terminal fencing ve single-flight enrollment; `test/ai06-consent-controller-races.test.ts` içine iki sentetik negatif vaka.
- Yeni commitin exact HEAD/CI run ID'si PR/Actions üzerinde doğrulanacak. Önceki CI sonuçları yeni HEAD için PASS değildir. Aynı workflow/SHA için aktif run tekrarlanmayacak.
- Ortak WAL/Windows test kaynakları, `main`, migration, installer, prod D1 ve canlı cihazlar değiştirilmedi.
- **Kalan P0:** bağımsız AI-08 #989 erken `complete(succeeded)` hatası; koordinatör Draft #996 native-verified marker migration hazırladı. AI-06 D1 kaynak entegrasyonu migration'ın doğru dalda uygulanmış kanıtına bağlı. Native OS effect-boundary ve iki-PC fiziksel kabul henüz yok.
- Kapanış: Draft + CORE NO-GO; merge/deploy yok.

## Revoke completion / lost ACK admission fence

Controller `revocationsPending` ve `revocationUncertain` ile
asenkron revoke ACK'si çözülmeden yerel enrollment'ı başlatmaz.
Gecikmiş eski başarılı ACK yeni revoke neslini temizlemez.
İki izole test eklenmiştir; yeni exact HEAD'in CI kanıtı beklenir.
Önceki HEAD `033596d00b67e156d9c7696fc8ab71d21fd3de06`,
run `41211401246`: **7/7 SUCCESS**, Node22/24 36/36 AI-06 PASS.
Migration #996 ayrı Draft; protected effect boundary ve AI-08 gate
olmadan CORE NO-GO sürer.

## Existing enrollment reuse TOCTOU

AI-06 sahibi provider eski kaydedilmiş native consent'i tekrar
kullanırken taze D1, Broker ve persistent local pending/STOP koşullarını
doğruluyor. Native currentReadback aralığında değişen owner/ready/
platform/session veya başka Agent pending işinde consent reuse
reddedilir. Dört sentetik negatif test eklendi. Yeni exact SHA'nın
CI sonucu beklenir; migration #996 ve protected OS effect-boundary
halen koordinatör/AI-03 bağımlılığıdır, CORE NO-GO.
