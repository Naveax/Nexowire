# Nexowire 2026-10-30: Birleşik Kaynak Adayı

> **DRAFT / Main'e birleştirme onayı değil.** Bu dal kaynak doğrulamasına ayrılmıştır. Production deploy, gerçek cihaz, UAC, CORE/ROOT yetkisi veya mevcut Agent verisi üzerinde işlem yapılmadı.

## Amaç
Bağımsız ve değişen dosyaları çakışmayan, exact-HEAD kaynak CI'si başarılı dört açık Draft PR'ı **tek bir entegrasyon branch'inde** toplamak. Kaynak PR'lar açık ve Draft kalır. Bu dört kaynak branch'i silinmez; ayrıca main üzerindeki branch temizliği ayrı katalogda izlenir.

- Entegrasyon dalı: `integration/ready-source-batch-20261030`
- İlk `main` SHA: `3d5a3a810ec96d7bdf35d4a35da35a2178512caf`
- Entegrasyon öncesi `main` katalogu: [Branch kataloğu](BRANCH_CATALOG.md)
- İlk entegrasyon merge SHA'ları: `9c0a006980db53038f64b110cf6e92c1b608c596`, `bf6c9fe4c5a04050005ba779642561e86c70f699`, `b98e78cf052b54066708a880bba0f447a7957b28`, `9639b1568e316a2463dac029d73bdf34b49085ae`.

## Birleştirilen işler
| Kaynak | Exact source SHA | Entegrasyon PR | Kaynak CI | Kapsam |
| --- | --- | --- | --- | --- |
| [#972](https://github.com/Naveax/Nexowire/pull/972) | `9bf1a6209ba8e645e51d739598fffeb4b67d2c50` | [#975](https://github.com/Naveax/Nexowire/pull/975) merged | SUCCESS #40958400282 | Windows Agent Scheduled Task pil/UPS ayarları ve regresyon |
| [#957](https://github.com/Naveax/Nexowire/pull/957) | `88fa241df3c0c1721638bb2420918ae9fc3866bf` | [#976](https://github.com/Naveax/Nexowire/pull/976) merged | SUCCESS #40827072868 | SQLite WAL recycle kontrolü, bağımsız QA negatifleri |
| [#973](https://github.com/Naveax/Nexowire/pull/973) | `0818411b9d07bf9efbc75ba94fe28d1e94ac1ccc` | [#977](https://github.com/Naveax/Nexowire/pull/977) merged | SUCCESS #40961847349 | Sunucu tarafından doğrulanan GitHub ID'ye dayalı sınırlı kota yapılandırması |
| [#971](https://github.com/Naveax/Nexowire/pull/971) | `859a54733a429c90a99af0163f8059ab62b85e45` | [#979](https://github.com/Naveax/Nexowire/pull/979) merged | CI SUCCESS #41019875330; Release Readiness SUCCESS #41019875369 | İlk Windows kurulum, Unicode kısayol ve ChatGPT OAuth rehberi |

## Entegrasyon kanıtı
İlk üç entegrasyon merge'ünden sonraki GitHub karşılaştırması `ahead=13`, `behind=0` döndürdü; dördüncü merge #979, Windows onboarding dosyalarını da ekledi. `main` 30 Ekim'de bağımsız katalog güncellemesiyle ilerlemiştir; her yeni HEAD için karşılaştırma yeniden doğrulanmalıdır. Kaynak PR'lar açık / Draft kalır.

Bu, kaynakların tam çalışma zamanında uyumlu olduğunu tek başına kanıtlamaz. **Birleşik HEAD CI** ve code review ayrı kabul şartlarıdır.

## Ayrı kalan adaylar
- [#971](https://github.com/Naveax/Nexowire/pull/971), tüm kaynak CI ve release-readiness başarılı olduğundan [#979](https://github.com/Naveax/Nexowire/pull/979) ile bu dalda birleştirildi; canlı kurulum/OAuth fiziksel doğrulaması yapılmış sayılmaz.
- [#958](https://github.com/Naveax/Nexowire/pull/958), [#968](https://github.com/Naveax/Nexowire/pull/968) ve alt CORE güvenlik zincirleri: ayrı kaynak/entegrasyon güven sınırları. CORE production NO-GO. Bunlar onaysız biçimde tek operasyona katılmaz.
- Diğer açık Draft PR'lar: kod/satır çakışması, test hedefi, parent-child DAG ve birebir diff karşılaştırması olmadan toplu merge yapılmaz.

## Merge ön koşulları
1. Entegrasyon PR'ı **Draft** kalmalı. Exact HEAD birleşik CI tamamlanıp başarılı olmadan main'e merge yok.
2. Main değişirse merge-base/diff ve kaynak HEAD'leri tekrar doğrula; çoklu işlemleri aynı eski SHA ile yeniden çalıştırma.
3. WAL için replay/UNKNOWN güvenliği; Agent için gerçek Windows Scheduled Task semantiği; quota için OAuth ID ve impersonation negatifleri korunmalı.
4. Prod Cloudflare/D1 değişikliği ve Agent güncellemesi ayrıca onaylanır. CORE açık hale getirilmez.
5. Kaynak PR'ların açık kalması normaldir; bağımlı PR'lar ve son 48 saatte güncellenen branch'ler otomatik temizlenmez.

Bu belge kaynak birleşimini açıklar; fiziksel kabul veya dağıtım raporu değildir.

## GitHub branch temizliği

30 Ekim'de, açık PR HEAD/base bağımlılığı bulunmadığı, son tip commit'i 48 saatten eski olduğu ve patch eşdeğerliği doğrulandığı için 7 eski remote branch silindi. Kaynak PR #971/#972/#957/#973 HEAD'lerine dokunulmadı. Tam SHA/kanıt ve güncel 375-branch envanteri için [`main/docs/BRANCH_CATALOG.md`](https://github.com/Naveax/Nexowire/blob/main/docs/BRANCH_CATALOG.md) incelenmelidir.
