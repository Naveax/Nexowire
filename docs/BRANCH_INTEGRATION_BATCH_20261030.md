# Nexowire 2026-10-30: Birleşik Kaynak Adayı

> **DRAFT / Main'e birleştirme onayı değil.** Bu dal kaynak doğrulamasına ayrılmıştır. Production deploy, gerçek cihaz, UAC, CORE/ROOT yetkisi veya mevcut Agent verisi üzerinde işlem yapılmadı.

## Amaç
Bağımsız ve değişen dosyaları çakışmayan, exact-HEAD kaynak CI'si başarılı üç açık Draft PR'ı **tek bir entegrasyon branch'inde** toplamak. Kaynak PR'lar açık ve Draft kalır. Mevcut branch'ler silinmez.

- Entegrasyon dalı: `integration/ready-source-batch-20261030`
- İlk `main` SHA: `3d5a3a810ec96d7bdf35d4a35da35a2178512caf`
- Entegrasyon öncesi `main` katalogu: [Branch kataloğu](BRANCH_CATALOG.md)
- İlk entegrasyon merge SHA'ları: `9c0a006980db53038f64b110cf6e92c1b608c596`, `bf6c9fe4c5a04050005ba779642561e86c70f699`, `b98e78cf052b54066708a880bba0f447a7957b28`.

## Birleştirilen işler
| Kaynak | Exact source SHA | Entegrasyon PR | Kaynak CI | Kapsam |
| --- | --- | --- | --- | --- |
| [#972](https://github.com/Naveax/Nexowire/pull/972) | `9bf1a6209ba8e645e51d739598fffeb4b67d2c50` | [#975](https://github.com/Naveax/Nexowire/pull/975) merged | SUCCESS #40958400282 | Windows Agent Scheduled Task pil/UPS ayarları ve regresyon |
| [#957](https://github.com/Naveax/Nexowire/pull/957) | `88fa241df3c0c1721638bb2420918ae9fc3866bf` | [#976](https://github.com/Naveax/Nexowire/pull/976) merged | SUCCESS #40827072868 | SQLite WAL recycle kontrolü, bağımsız QA negatifleri |
| [#973](https://github.com/Naveax/Nexowire/pull/973) | `0818411b9d07bf9efbc75ba94fe28d1e94ac1ccc` | [#977](https://github.com/Naveax/Nexowire/pull/977) merged | SUCCESS #40961847349 | Sunucu tarafından doğrulanan GitHub ID'ye dayalı sınırlı kota yapılandırması |

## Entegrasyon kanıtı
GitHub `main...integration/ready-source-batch-20261030` karşılaştırması üç merge ardından `ahead=13`, `behind=0`, merge-base `3d5a3a810ec96d7bdf35d4a35da35a2178512caf` döndürdü. Değişen 9 dosya: `cloudflare/worker.js`, `docs/AGENT_LIFECYCLE.md`, `docs/FREE_ONLY_POLICY.md`, `src/agent/native-agent-lifecycle.ts`, `src/agent/operation-journal-wal.ts`, `src/product/control-plane-service.ts`, `test/free-only-usage.test.ts`, `test/native-agent-lifecycle.test.ts`, `test/qa-journal-wal-recycle-p11.test.ts`.

Bu, kaynakların tam çalışma zamanında uyumlu olduğunu tek başına kanıtlamaz. **Birleşik HEAD CI** ve code review ayrı kabul şartlarıdır.

## Henüz eklenmeyen adaylar
- [#971](https://github.com/Naveax/Nexowire/pull/971) ilk kurulum/OAuth: yeni exact HEAD `859a54733a429c90a99af0163f8059ab62b85e45`. 30 Ekim 2026 taramasında CI #41019875330 ve Release Readiness #41019875369 **in_progress** idi. Önceki SHA PASS yeni SHA için PASS değildir. Aynı run tekrar tetiklenmemelidir. Canlı kullanıcı OAuth ve kurulum testi ayrıca gereklidir.
- [#958](https://github.com/Naveax/Nexowire/pull/958), [#968](https://github.com/Naveax/Nexowire/pull/968) ve alt CORE güvenlik zincirleri: ayrı kaynak/entegrasyon güven sınırları. CORE production NO-GO. Bunlar onaysız biçimde tek operasyona katılmaz.
- Diğer açık Draft PR'lar: kod/satır çakışması, test hedefi, parent-child DAG ve birebir diff karşılaştırması olmadan toplu merge yapılmaz.

## Merge ön koşulları
1. Entegrasyon PR'ı **Draft** kalmalı. Exact HEAD birleşik CI tamamlanıp başarılı olmadan main'e merge yok.
2. Main değişirse merge-base/diff ve kaynak HEAD'leri tekrar doğrula; çoklu işlemleri aynı eski SHA ile yeniden çalıştırma.
3. WAL için replay/UNKNOWN güvenliği; Agent için gerçek Windows Scheduled Task semantiği; quota için OAuth ID ve impersonation negatifleri korunmalı.
4. Prod Cloudflare/D1 değişikliği ve Agent güncellemesi ayrıca onaylanır. CORE açık hale getirilmez.
5. Kaynak PR'ların açık kalması normaldir; bağımlı PR'lar ve son 48 saatte güncellenen branch'ler otomatik temizlenmez.

Bu belge kaynak birleşimini açıklar; fiziksel kabul veya dağıtım raporu değildir.
