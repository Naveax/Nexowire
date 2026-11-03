# S4-01 — Plan ve ücret durumları

31 Ekim 2026 | Base main `a19a228dc6f19fd484cf935e941a00ea625233f8` | Dal `docs/delegated-s4-s5-20261031`
Kanıt türü: source-only / dokümantasyon; fiziksel veya üretim kabulü değildir.

## Kaynaklar

Tüm kaynaklar base SHA üzerindedir: [Free-only](../FREE_ONLY_POLICY.md), [S2/S4 teklif](../SCALE_V2_S2_S4_QUOTA_SUBSCRIPTION_STAGING.md), [checkout gate](../SCALE_V2_S4_CUSTOM_USAGE_CHECKOUT_GATE.md), [S5 kabul sınırları](../SCALE_V2_S5_LOAD_COST_ACCEPTANCE_20261018.md). İlgili işler: #486, #487. Canlı endpoint sorgulanmadı.

## Mevcut politika ile önerinin ayrımı

Kaynak politikası Free için UTC takvim ayında 1.000 ağırlıklı birim, normal çağrı 1x / skill 5x der. Bu çalışma canlı konfigürasyonu doğrulamaz. Billing kapalı kalır. Kaynakta belirtilen server-verified istisnalar ek cihaz, tenant veya premium yetki vermez.

| Plan | Gelecek öneri | Billing paused etkisi | Cihaz / tenant |
|---|---|---|---|
| Free | 1.000 mantıksal kök/gün; henüz etkin değil | Mevcut aylık Free politikası | Ayrı owner/device ve kapsam doğrulaması |
| Plus | 5.000 kök/gün; öneri | Ücretli hak verilmez | Abonelik cihaz sahipliğinin yerine geçmez |
| Pro | 10.000 kök/gün; öneri | Ücretli hak verilmez | Tenant üyeliği ayrıca doğrulanır |
| Enterprise | Sonlu, onaylı sözleşme; kapasite garantisi yok | Ücretli hak verilmez | Tenant subject, üyelik/rol, device owner ayrı |

| Olay / durum | Kapalı billing davranışı | Gelecek muhafazakâr aday davranış | Açık karar |
|---|---|---|---|
| BILLING_PAUSED | Billing yolları 503; Free entitlement; eski paid kayıt silinmez | Başka tüm durumlara üstün kapatma kapısı | Etkinleştirme yetkisi yok |
| ACTIVE | Ücretli geçiş yok | Ancak doğrulanmış settlement, hesap/variant, süre, consent, tenant, kota birlikte geçerse aday hak | Gerçek provider kanıtı BEKLEMEDE |
| PAST_DUE | Free-only sürer | Yeni paid kabul reddi | Grace politikası BEKLEMEDE |
| CANCELED | Free-only sürer | Yeni paid kabul reddi | Dönem sonuna kadar hak BEKLEMEDE |
| REFUNDED | Ödeme/iade yapılmaz | Aday hak reddi; tarihçe korunur | Kısmi iade BEKLEMEDE |
| CHARGEBACK | Ödeme yapılmaz | Aday hak reddi; eski active olayı geri açamaz | Uyuşmazlık süreci BEKLEMEDE |
| Bilinmeyen / eksik settlement | Free-only sürer | Fail closed; inceleme | Yetkili reconciler BEKLEMEDE |

Eski BillingService bazı paused/past_due veya iptal grace durumlarını aktif kabul edebilir; öneri daha katıdır. Bu belge mevcut uygulama semantiğini değiştirmez. Gerekirse ana ekip sürümlü geçiş kararı vermelidir. Ödeme kimliği, kota admission ve cihaz/tenant grant birbirinden ayrı kapılardır.

Fiyat, para birimi, vergi, sağlayıcı hesabı, hukuki uygunluk, sözleşme, yenileme/iptal/iade metni ve retention onayı: **BEKLEMEDE**. Fiyat teklif edilmez. Provider imzası/settlement ve gerçek checkout test edilmedi.
