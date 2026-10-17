# Scale v2 S2/S4 | Custom Usage disclosure and consent evidence (DEV, NOT LIVE)

**2026-10-15**. User's requested product: self-selected **100–850,000 logical Nexowire tool calls/day**, maximum **600 MCP requests/minute for the default OpenAI Secure MCP Tunnel**. All subscription and login/cancel/checkout flows are still inactive; the deployed Free tier remains **1,000 weighted credits per UTC month**. This is a stand-alone DEV proposal based on verified main `eca9a791eff70dbe3c5ab5379397a6e962b5c633`. No live control-plane/Worker/Hub/Agent/GitHub OAuth imports, cloud migrations, billing changes or public DNS/Funnel edits.

## Mandatory product communication (show BEFORE account signup / purchase)

**Marketing/product listing directly under the plan amount:**

> Custom Usage: seçtiğiniz günlük 100–850.000 Nexowire mantıksal tool çağrısı kullanım üst sınırıdır. Bir gün içinde tamamını kullanacağınız garanti edilmez. OpenAI Secure MCP Tunnel kullanılıyorsa varsayılan 600 MCP isteği/dakika üst sınırı, aynı tünel ve çağıran uygulamayı kullanan istekler arasında ortaktır. Açılış/keşif, kimlik doğrulama, tekrar deneme, internet kesintisi, cihazınızın açık olması, ChatGPT hesap/çalışma alanı izinleri ve paylaşılan bağlantı trafiği fiili kullanımı etkiler.

- `850,000/600=1,416.67` dakika = **23 saat 36 dakika 40 saniye** hiç kesintisiz dolu trafik; **864,000/gün** fiziksel matematiksel tavan, yalnızca 14,000 istek payı. Bu rakam *platform SLA* veya bireysel müşteri garantisi değildir.
- **Transport scope**, Nexowire `accountId` değil, doğrulanmış **tunnel ID + calling application ID**, aksi hâlde tunnel+user varsayılan kapsamıdır; bunu bireysel 600/dakika garantisi gibi göstermeyin. Başka tünel/transport kullanılan hesaplara aynı OpenAI limitinin mutlaka geçerli olduğunu iddia etmeyin. Güncel resmi belge: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- ChatGPT planının yazma/çalıştırma yetkileri kullanıcının ChatGPT planı/workspace ve OpenAI ürün koşullarına bağlıdır; Nexowire Custom Usage satın alma bu izinleri vermez. Gerekliyse checkout'tan önce uyumluluk denetimi yapın.
- İçerik fiyatlandırması, IP/domain, sağlayıcı, cihaz, sözleşme ve ödeme şartlarına göre değişebilir. Kullanıcının **850.000 kotayı satın alması**, Nexowire'ın mantıksal üst sınırı tanımlama yükümlülüğü doğurur; *garanti etmemek* kötü/ayıplı hizmeti veya tüketici haklarını otomatik kaldırmaz.

## Privacy vs contract acceptance: do NOT combine

Türkiye KVKK **18.02.2026 tarihli 2026/347 ilke kararı** aydınlatma metninin açık rıza metninden ayrı tutulmasını vurgular. Aydınlatma **rıza almak değildir**. Kişisel veri işlemenin kanuni dayanağı ayrıca sınıflandırılmalı, gerekli gerçek açık rızalar işleme amacı bazında özgürce ve ayrı alınmalı; pazarlama izni (varsa) isteğe bağlı ve önceden işaretlenmemiş olmalıdır.

**Signup flow**:
1. Gerçek veri sorumlusu, veri kategorileri/amaçlar, hukuki sebep, saklama, aktarım, ilgili kişi hakları bilgilerini içeren **KVKK aydınlatma metnini görüntüle**. Görüntülendiği kaydedilebilir ancak “KVKK açık rızasını kabul ediyorum” zorunlu onayına dönüştürülmez.
2. Gerçek sürümlü **Hizmet Kullanım Koşulları** için zorunlu, boş başlayan `[ ] Koşulları okudum ve kabul ediyorum`.
3. Gerekli ise her ayrı işleme amacı için isteğe bağlı, boş başlayan ek açık rıza; örneğin pazarlama için `[ ] Kampanya iletileri istiyorum`. Pazarlama kutusu boş bırakılınca hesap engellenmez.
4. Checkout'taki ayrı onay, signup onayıyla **asla** otomatik verilmiş sayılamaz.

**Custom Usage checkout flow**:
1. Fiyatın vergiler dahil toplamı, tutarın para birimi, dönem/yenileme, satıcı ticaret unvanı ve iletişim adresi, cayma/iptal/iade koşulları, seçilen günlük kota, sağlayıcı/ChatGPT gereksinimleri ve ortak 600/dakika sağlayıcı sınırı **ödeme öncesinde açıkça** gösterilir. Henüz gerçek fiyat veya satıcı/iptal kimliği belirlenmediyse **satın alma kapalı**.
2. Boş başlayan **ayrı** kutular: `[ ] günlük kota ile gerçek aktarım hızının farklı olduğunu anladım`; `[ ] mesafeli satış ön bilgilendirmesini inceledim`; `[ ] abonelik sözleşmesi ve hizmet koşullarını kabul ediyorum`.
3. Ayrı müşteri verisi pazarlama izni isteğe bağlıdır ve satın alma onayına bağlanmaz.
4. Satın alma düğmesi ödeme yükümlülüğünü açıkça belirtmeli ve kayıt sonrası metin/fiyat/yenileme/iptal bilgileri kullanıcının erişebileceği **kalıcı saklayıcıda** sunulmalıdır. Açık cayma hakkı istisnası varsa uzman hukuk incelemesi gerekir; tüm aboneliklerin otomatik cayma hakkı dışı olduğunu söylemeyin. Ön bilgilendirme ve fiyat/iptal alanı son anda değiştirilirse **yeni açık onay** aldırılmalı.

Official Turkish sources (legal review, not a complete jurisdictional legal opinion):
- https://www.kvkk.gov.tr/Icerik/8710/veri-sorumlulari-tarafindan-acik-riza-ve-aydinlatma-metinlerinin-ayri-ayri-duzenlenmesi-gerektigi-hakkinda-kisisel-verileri-koruma-kurulunun-18-02-2026-tarihli-ve-2026-347-sayili-ilke-kararina-iliskin-kamuoyu-duyurusu
- https://tuketici.ticaret.gov.tr/yayinlar/tuketici-bilgi-rehberi/mesafeli-sozlesmeler-hakkinda-bilgilendirme
- https://tuketici.ticaret.gov.tr/yayinlar/tuketici-bilgi-rehberi/abonelik-sozlesmeleri-hakkinda-bilgilendirme

## What is actually implemented

- `src/product/custom-usage-disclosures-proposal.ts`: DEV-only pinned disclosure template/version, server-only 15-minute HMAC-signed account-bound signup or purchase offer, trusted price/currency/merchant/contact/cancel URL and immutable document revisions. It verifies the exact offer hash with timing-safe HMAC and stores a timestamped account-bound receipt using owner-controlled SQLite.
- `test/fixtures/scale-v2-custom-usage-disclosures-dev.sql`: DEV-only unique receipt keyed by owner/flow/offer nonce, version and snapshot SHA256, marketing opt-in separate and default false in the preview. Existing receipt isn't overwritten by revised prices or changed optional marketing; the same signed offer can be retried idempotently.
- `test/custom-usage-disclosures-staging.test.ts`: 13 tests: pricing/quota/version binding, mandatory purchase confirmations, signup/privacy notice separation, optional marketing, wrong-account and tampered price/token, stale offer, invalid signing secret, 100–850,000 bounds, offer nonce collision, prior signup not granting checkout, fail-closed database.
- `web/custom-usage-consent-preview.html`: standalone unlinked **DEV preview**, explicitly no payment, no actual registration, no simulated server acceptance, sample seller/price not valid. It demonstrates accessible separate signup and purchase sections, unchecked consent, privacy notice reading, quota selector and highly visible 600/min limitation. It is **not** a legal document or consumer production screen.
- The original `web/index.html` GitHub OAuth and `src/product/billing-http.ts` checkout APIs remain **unchanged**. The preview has **disabled checkout** and no API side effects, and this proposal cannot authorize payment, new daily quotas or signup.

## Release blockers

1. Legal counsel reviews actual entity's complete KVKK inventory, legally required contract text and countries served; no generic “one checkbox removes liability” shortcut.
2. Final approved immutable document body + public or signed durable link, checksum, locale, effective dates, distribution and withdrawal/versioning. Real checkout captures exact approved content and verified prices; 15m token / secure server clock / CSRF / authenticated owner binding.
3. Add authoritative signed offer issuance and account-bound receipt validation **server-side** to real GitHub OAuth onboarding and billing checkout gate only after disabled-by-default staging integration and provider sandbox proof. Never use a client-provided `entitlementVerified` or checkbox as payment authorization.
4. Add accessibility/keyboard/mobile, data minimization, records retention/deletion, audit trails, consent revocation workflows, billing cancellation and refund; must meet applicable rules outside Türkiye if serving globally.
5. Complete separate per-calling-app full ingress transport throttling. Existing Custom Usage PR #511 measures **admitted tool calls**, not all Secure MCP Tunnel provider requests. 850,000 actual remote daily capacity is NOT proven; owner-operated zero-incremental-cloud-bill plan stays in force.
6. Existing Free 1,000 **weighted/month** remains live, future Free/Plus/Pro daily 1,000/5,000/10,000 and Custom 100–850,000 remain OFF. No customer charges initiated.

**GO/NO-GO:** developer proof only; production signup and subscription acceptance **NO-GO**.
