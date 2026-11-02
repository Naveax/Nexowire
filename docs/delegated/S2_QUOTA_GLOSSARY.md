# S2-01 — Kota sözlüğü

> 31 Ekim 2026 · Yardımcı 2 · source-only / documentation. Kaynak snapshot: `a19a228dc6f19fd484cf935e941a00ea625233f8` (main). Canlı durum ve fiziksel kabul doğrulanmadı.

## Mevcut sözleşme ve öneri

| Alan | Mevcut Free-only (repo belgesi) | Günlük öneri — ETKİN DEĞİL |
|---|---|---|
| Free | 1.000 ağırlıklı birim / UTC takvim ayı | 1.000 kabul edilmiş mantıksal çağrı / UTC gün |
| Plus / Pro | Billing paused; canlı ücretli hak çıkarılamaz | 5.000 / 10.000 mantıksal çağrı / gün |
| Skill | Doğrudan skill_*/skills_* veya doğrulanmış special-skill metası 5x; sıradan çağrı 1x | daily-quota-proposal çağrıyı 1 sayar; ayrı 5x bütçe/pazarlama sözleşmesi kararı bekler |
| Reset | Ayın ilk günü 00:00 UTC | Her gün 00:00 UTC |
| Limit dolunca | Dispatch öncesi reddet | Aynı güvenli hedef; üretim kanıtı değildir |
| Kimlik | Hesap → quota subject; Free device-anchor bağlantıları kullanımı birleştirebilir | Dağıtık atomiklik ve geçiş ayrıca doğrulanmalı |
| Ödemeler | BILLING_PAUSED | Bu öneri ödeme açmaz |

Bu tabloda mevcut, **main kaynağında belgelenen** anlamındadır. Canlı servis konfigürasyonu veya hesaba kalan kota sorgulanmadı. Sunucuda doğrulanmış sabit GitHub kimliklerine özel hosted kredi istisnaları var; genel Free hakkı değildir. Açık PR #991 SinsiVinci istisnası bir kaynak önerisidir, bu snapshot'ın genel kuralına eklenmedi. İstisnalar premium araç, cihaz yetkisi ve dış sağlayıcı kapasitesi vermez.

## Terimler

| Terim | Anlam / sınır |
|---|---|
| Tool çağrısı | Hosted MCP aracının bir çağrısı; HTTP alt istek veya kullanıcı mesajı sayısı değildir. |
| Skill 5x | Mevcut modelde 5 ağırlıklı birim. İşaretlenmemiş sıradan çağrının skill'den geldiği tahmin edilmez. |
| Request ID | JSON-RPC korelasyon anahtarı; oturumlar arasında yeniden kullanılması ücretsiz çağrı hakkı vermez. |
| Logical invocation | Bir kasıtlı işlem. Yeni işlem yeni invocation ID alır. |
| Retry | Aynı işlemin ağ yeniden gönderimi. Sabit nexowire/invocation-id varsa duplicate 409, ikinci yürütme yok; yoksa yeni ücret doğabilir. Bilinmeyen mutation körlemesine tekrarlanmaz. |
| Idempotency | Tek mantıksal işlem için yeniden gönderimin ikinci etki oluşturmaması. Ücretsiz ikinci yürütme anlamına gelmez. |
| Relay byte | Sunucu üzerinden taşınan bayt; çağrı sayısından ayrı ağ/kaynak bütçesi. |
| P2P | Payload'ın doğrudan taşınması; hosted kimlik/yetki/kota isteklerini ortadan kaldırmaz. |
| UTC dönem başlangıcı | Yerel Türkiye saati değil; aylık ayın 1'i, öneride günün başlangıcı. |
| Quota subject | Oturum, e-posta ve cihaz alias'ından ayrı kullanım kimliği. Device anchor kusursuz fiziksel kimlik kanıtı değildir. |

## Çevrimdışı örneği çalıştırma

`quota-examples.ts` yalnız saf fonksiyon sunar, CLI veya dosya okuma/yazma yoktur. Zorunlu örnek politika adları **resmî sunucu policy sürümü değildir**:

- `free-monthly-weighted-example-v1`: yalnız Free; 1x/5x, UTC ay.
- `daily-logical-proposal-example-v1`: Free/Plus/Pro önerisi; her çağrı 1, ayrı ağırlıklı gösterim.

Girdi: `{policyVersion, tier, at: "2026-10-31T23:59:59.999Z", events: [{invocationId:"synthetic-1",kind:"skill",quantity:1}]}`.
İlk politikada used=5, remaining=995; ikincide Free used=1, remaining=999 ve skill5x=5 yalnız ayrı açıklayıcı sayaçtır. `quantity` tam 1 olmalı; çoklu çağrı ayrı sentetik ID'lerle yazılır. Negatif/0/kesir/toplu miktar hata; duplicate açık uyarı ve 0 ikinci sayım üretir.

Tek girdinin olayları yalnız belirtilen döneme aittir; fonksiyon tarihsel/global replay deposu, gerçek account/device doğrulaması, paid entitlement veya eşzamanlı ledger değildir. Tekrarlanan ID'yi dönemler arasında izleyemez. Örnek yeni dönemde işlem tekrarlama izni vermez. Aynı girdi aynı sonucu verir; gerçek log veya kimlik kullanılmaz.

Test: `node --test --import tsx test/delegated/quota-examples.test.ts` (bağımlılıklar kurulu izole clone). Test-only başarı üretim quota kabulü değildir.

## Kanıt kaynakları

Snapshot'a göre okunmuş: [FREE_ONLY_POLICY](../FREE_ONLY_POLICY.md), [QUOTA_IDENTITY](../QUOTA_IDENTITY.md), [quota/cost](../SCALE_V2_QUOTA_AND_COST.md), [daily proposal](../SCALE_V2_S2_DAILY_QUOTA_PROPOSAL.md), [saf öneri kaynak kodu](../../src/product/daily-quota-proposal.ts). Issue [#484](https://github.com/Naveax/Nexowire/issues/484). Açık [#991](https://github.com/Naveax/Nexowire/pull/991) merge/deploy kanıtı değildir.

## Yerel doğrulama kaydı

31 Ekim 2026, Linux / Node v24.22.1. `npm ci --ignore-scripts --no-audit --no-fund` exit 0. `node --test --import tsx test/delegated/quota-examples.test.ts`: 18 deterministik test, 0 fail/skip (son yerel kontrol). `npm run typecheck`, `npm run build`, `npm run continuation:check`: exit 0. Continuation çıktısındaki geçmiş cihaz kaydı güncel fiziksel durum kanıtı olarak kullanılmadı. Yerel kontroller yalnız kaynak/sentetik düzeydedir; CI ve PR exact HEAD raporu ayrıca verilir.

Açık PR listesi başlangıçta okundu (#980–#996 dahil); bu dosyalar snapshot'ta yoktu. İlgili kaynak kod kontrolü: `src/product/plans.ts` Free 1.000, `src/product/usage-policy.ts` skill 5x ve `src/mcp/hosted-metering.ts` special-skill/duplicate işleme. Mevcut modüller kopyalanmadı veya değiştirilmedi. Örnek araç yalnız tek dönemlik açıklayıcı hesaplamadır.
