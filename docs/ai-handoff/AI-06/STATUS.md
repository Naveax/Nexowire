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

## Latest D1 P0 source work

`src/product/d1-core-console-authority.ts`: second post-native-readback, winner-only `native_claim_verified` D1 CAS and signed completion gate. Three new isolated regressions cover premature complete, native DENY/UNKNOWN and old schema fail-closed. Coordinator #996 migration is a separate Draft and NOT in AI-06 base. Synthetic fixture SQL is test-local only. The previous exact HEAD `b120183fca21076390c41aedfa79af93393149db` CI [#41243933313](https://github.com/Naveax/Nexowire/actions/runs/41243933313) was **7/7 SUCCESS** with 42 AI-06 tests; new exact SHA/CI must be separately confirmed. CORE NO-GO.

## Atomic owner binding in verification CAS

The D1 `currentPredicate` now includes the **original**
`owner_account_id` in every guarded current-state mutation. Three
adversarial post-readback/pre-CAS cases cover re-pair with new owner's
preferences enabled, changed Windows logon epoch, and lost Broker
privilege. Exact new HEAD CI evidence must be checked separately; no
physical Windows authority is inferred. Production CORE NO-GO.

## Verified-claim late-completion race tests

Added four new synthetic negatives to `test/ai06-consent-claim-races.test.ts`. A verified D1 marker must not allow `complete(succeeded)` if the owner/device/platform/Broker/native logon changes before the final SQL UPDATE. All tests remain fail-closed and preserve replay tombstones. Previous exact HEAD `d9dc636ebbabe7a82a5e34170da5e7517eeb22d4`, CI `41247107420` was 7/7 SUCCESS, Node22/24 48/48 AI-06 PASS. The **new SHA is not PASS until its own matching CI finishes**. Coordinator #996 migration not in this base, physical CORE NO-GO.

## Controller explicit runtime admission fields

Controller ACTIVE now requires explicit Win32, READY, and verified local Broker probe in addition to signed owner policy/native admission. Six new negatives cover missing and contradictory fields with a forged `nativeAdmission='verified'` assertion. The existing last verified SHA `6b4833887a5895cf3395b6d6c96d0a435123d6a0` had 52/52 AI-06 PASS on Node22/24, CI `41248715419` Windows remained in progress at that check. A new commit with six tests requires fresh exact-HEAD CI; never inherit old PASS. Coordinator #996, AI-08 #989 and OS effect proof remain blocking; CORE NO-GO.
