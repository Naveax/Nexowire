# AI-08 | P0: readback-pending complete(succeeded) kabulü

**Kayıt tarihi:** 2026-11-01  
**Kanıt seviyesi:** `SYNTHETIC_SQLITE` / dispose edilebilir, in-memory SQLite + sentetik Ed25519. **Fiziksel Windows onayı, gerçek effect yürütme veya production D1 kanıtı değildir.**  
**Risk kararı:** **FAIL / BLOCKED**. `CORE_EXECUTOR_DISPATCH_ENABLED=false`, CORE production **NO-GO**.

## 1. Bağımsız tekrar üretim, exact SHA

- **PR:** [AI-08 Draft #989](https://github.com/Naveax/Nexowire/pull/989); branch `ai/08-independent-qa-20261031`.
- **Kaynak HEAD:** `acdd659ab8181039f0a92571ab113193eaf4798c`.
- **Base HEAD:** `9d0f35607d4cde87bd031e2da77855cfaf570c31` (#984).
- **Workflow:** [GitHub CI #41249373284](https://github.com/Naveax/Nexowire/actions/runs/41249373284), workflow ID `369213208`, `pull_request`, attempt **1**.
- **Node 22 job:** `124679715031`, **FAILURE**.
- **Hata testi:** `test/ai08-console-claim.test.ts`, **`AI-08: complete cannot acknowledge success before native claim readback`** (eski testin beklentisi **değiştirilmedi**).

| Assertion | Beklenen güvenli sonuç | CI'da gerçekleşen |
|---|---|---|
| `acceptedEarly` | `false` | **`true`** |
| `stateAfterDeniedReadback` | `unknown` | **`succeeded`** |

**Node 22 ölçümü:** `2.826 test / 2.469 PASS / 1 FAIL / 354 SKIP / 2 TODO`; **56 AI-08 testinden 55 PASS, yalnız bu P0 FAIL**. Bu sayılar yalnız yukarıdaki exact HEAD + run + job içindir.

### Saldırganın kullanabileceği sıra

1. Tekil imzalı işlem `reserve` sonrası `claim` yapar. İmzalı claim `reserved -> dispatched` yazarken bağımsız `nativeEnrollmentVerifier.currentReadback` hâlâ beklemektedir.
2. Aynı request ID / fingerprint kapsamıyla ayrı geçerli imzalı `complete(succeeded)` çağrısı gelir. Eski SQL, yalnız `state='dispatched'` kontrol ettiği için başarı ACK'i üretir.
3. Native readback sırasında cihaz offline yapılır, daha sonra `claim` fail-closed reddedilir.
4. Terminal kaydın `unknown` olması gerekirken `succeeded` kalır. Bu, **henüz doğrulanmayan operasyonun başarılı diye kaydedilmesi**, audit/reconciliation mantığının yanıltılması ve native admission bypass riskidir. **Gerçek OS komutunun çalıştırıldığını kanıtlamaz.**

**Kök neden (#984 kaynak):** `src/product/d1-core-console-authority.ts` claim `reserved -> dispatched` durumunu `currentReadback` öncesinde kalıcılaştırır; `complete(succeeded)` sorgusu native-readback-sonrası dayanıklı admission belirteci aramaz. Başarısız claim'in sonradan `unknown` tombstone yapması, daha erken `succeeded` olarak işaretlenen kaydı kurtaramaz.

## 2. AI-06, koordinatör SQL ve #1007 aynı-SHA denetimi (read-only)

| PR | Exact HEAD / base | Mevcut kanıt |
|---|---|---|
| [AI-06 #985](https://github.com/Naveax/Nexowire/pull/985) | HEAD `e1081fbf8c6471099121bd48c7e4556f2a4fe709`, base `7e4093c30c1ead3cd22888184450c34aef4737da` | Source içinde native-readback-sonrası `native_claim_verified=1` CAS ve `complete` için belirteç koşulu var; ayrı CI #41249331481 gözlemde **in_progress**. |
| [Koordinatör #996](https://github.com/Naveax/Nexowire/pull/996) | HEAD `71286f47b11c6ba76ea59309c5a1aba4c3ea82dd`, base `7e4093c30c1ead3cd22888184450c34aef4737da` | Resmî `0021_core_console_native_claim_verified.sql` migrasyonu; CI #41246389410 **SUCCESS**. Kodla entegre/production deployed değildir. |
| [Birleşik child #1007](https://github.com/Naveax/Nexowire/pull/1007) | HEAD `61e8613e154916e5b260cc99d68aa7dc14495b6a`, **eski** AI-06 parent/base `d9dc636ebbabe7a82a5e34170da5e7517eeb22d4` | [CI #41247579710](https://github.com/Naveax/Nexowire/actions/runs/41247579710), attempt 1, **FAILURE**. Node 24 job `124674112476`: `2.817 total / 2.461 PASS / 2 FAIL / 352 SKIP / 2 TODO`. |

### #1007 neden kabul değildir?

- Child PR **migration 0021 dosyasını** taşıyor; ancak kendi `test/ai08-console-claim.test.ts` fixture'ı yalnız 0014/0015/0019/0020 migration'larını çağırıyor. **0021 test DB'ye uygulanmıyor**.
- **Yanıltıcı yeşil:** `complete cannot acknowledge success before native claim readback` Node24'te PASS görünüyor; eksik `native_claim_verified` SQL kolonu nedeniyle `complete` zaten hata döndürüyor. Bu, native-readback sonrası gerçek iki-aşamalı geçişin çalıştığını kanıtlamaz.
- **İki gerçek kırmızı:** `losing simultaneous claim cannot tombstone the dispatched winner` ve `complete before claim must not consume a reserved operation`, her ikisi **`no such column: native_claim_verified`** yüzünden FAIL.
- Child, AI-08'in yeni `HAS_NATIVE_CLAIM_MIGRATION` kontrollü test fixture'ının eski kopyasını içeriyor. Güncel AI-08 test blob'u ve güncel AI-06 parent HEAD **koordine edilmeden #1007 PASS sayılmamalı**. Başkasının PR/test dosyasına AI-08 tarafından doğrudan müdahale edilmedi.

## 3. Bağımsız kapsam-içi yeni regresyonlar

AI-08 kendi `test/ai08-console-claim.test.ts` dosyasına **6 yeni** negatif ekler:
1. `dispatched -> reserved` geri sarma / replay reddi (**#996 SQL trigger gerekli**).
2. `unknown -> reserved` geri sarma / replay reddi (**#996 SQL trigger gerekli**).
3. Reserved operation fingerprint ve owner epoch değiştirme reddi (**#996 SQL trigger gerekli**).
4. Geçerli imzalı ama yabancı fingerprint ile claim denemesi özgün isteğin tekil rezervasyonunu alamamalı.
5. Native readback beklerken imzalı `revoke` sonrası terminal UNKNOWN / late effect reddi.
6. Reserve ACK kaybını taklit eden tekrar `reserve` çağrısı aynı request ID için yeni işlem üretmemeli.

**Orijinal readback-pending complete ve losing-claim testleri korunur; latch ve assertion gevşetilmez.** Eski #984 bazında yeni ledger trigger testlerinin bilinçli RED olması, migrasyon eksikliğinin kanıtıdır. Bu altı testin yeni exact-HEAD CI sonucu oluşturulacak commit tamamlanmadan **NOT_TESTED**. Önceki 56 + 6 = **62 yazılmış AI-08 testi**.

## 4. Koordinatör entegrasyon ve kabul sözleşmesi

- **Tek ve aynı exact HEAD:** güncel, review edilmiş #985 runtime + #996 *gerçek* migrasyon + #989 **güncel** QA (eski child blob'u değil). Fixture, `0021` dosyasını gerçek SQL olarak uygulasın.
- D1 native verifier pending iken signed `complete(succeeded)` **reddedilmeli**. DENY/UNKNOWN claim terminal `unknown` kalmalı; `succeeded` asla kalmamalı. Positive path: geçerli native readback sonrası tekil `native_claim_verified=1` CAS ve tekil `complete` başarılı olmalı.
- Scope/device/owner/session, fingerprint, generation, revoke, SID/LUID, online/bridge ve immutable operation ID her async sınırda ve aynı CAS içinde korunmalı; lost-ACK ve restart/replay deny.
- **Test kanıtı:** yeni combined HEAD için Node 22/24, full QA, migrations, Windows browser-live ve build/typecheck exit code; eski PR CI sonuçlarını yeni SHA'ya taşımayın. Fiziksel Windows kernel worker/owner UAC/DPAPI/iki-PC kabulü **ayrı BLOCKED**.
- **Yetki:** AI-08 yalnız `test/ai08-*.test.ts`, `test/fixtures/ai08/**`, `docs/ai-handoff/AI-08/**` değiştirir. AI-06 kaynağı ve koordinatör #996/#1007 branch'i **salt-okunur**.

**Kabul sonucu:** **P0 FAIL (bağımsız eski base) / COMBINED BLOCKED (#1007 2 FAIL) / PHYSICAL NO-GO**.
