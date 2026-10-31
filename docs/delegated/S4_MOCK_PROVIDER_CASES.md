# S4-02 — Sentetik provider olay test planı

31 Ekim 2026 | Base main `a19a228dc6f19fd484cf935e941a00ea625233f8` | Dal `docs/delegated-s4-s5-20261031`
Kanıt türü: source-only / dokümantasyon; fiziksel veya üretim kabulü değildir.

## Kaynaklar

Tüm kaynaklar base SHA üzerindedir: [Free-only](../FREE_ONLY_POLICY.md), [S2/S4 teklif](../SCALE_V2_S2_S4_QUOTA_SUBSCRIPTION_STAGING.md), [checkout gate](../SCALE_V2_S4_CUSTOM_USAGE_CHECKOUT_GATE.md), [S5 kabul sınırları](../SCALE_V2_S5_LOAD_COST_ACCEPTANCE_20261018.md). İlgili işler: #486, #487. Canlı endpoint sorgulanmadı.

**YALNIZ PLAN — ÇALIŞTIRILMADI.** Gerçek webhook, imza, provider SDK veya checkout kullanılmaz. Her vaka billing=false, sahte A/B tenant ve deterministik UTC saatiyle ayrı bellek fixture üzerinde gelecekte modellenir.

| ID | Girdi dizisi | Beklenen model sonucu | Kanıt / durum |
|---|---|---|---|
| S4-01 duplicate | Aynı event iki kez | İkinci olay hak/kota etkisi üretmez | Önce/sonra hak revision ve etki sayısı; NOT RUN |
| S4-02 out-of-order | İptal sonrası eski active | Eski revision hak açmaz | Önce/sonra hak revision ve etki sayısı; NOT RUN |
| S4-03 upgrade | Free → Plus talebi | Paused iken checkout yok; adayda yeni onaylı revision | Önce/sonra hak revision ve etki sayısı; NOT RUN |
| S4-04 downgrade | Pro → Free ve kullanım limit üstü | Tarihçe korunur; yeni kabul yok | Önce/sonra hak revision ve etki sayısı; NOT RUN |
| S4-05 cancel | Aktif sözleşme iptali | Aday paid kabul durur; grace karar bekler | Önce/sonra hak revision ve etki sayısı; NOT RUN |
| S4-06 refund | Tam iade bildirimi | Aday paid hak reddi; otomatik para işlemi yok | Önce/sonra hak revision ve etki sayısı; NOT RUN |
| S4-07 partial-refund | Kısmi iade | UNKNOWN; ticari karar gerekli | Önce/sonra hak revision ve etki sayısı; NOT RUN |
| S4-08 debt | Past due | Aday paid kabul reddi | Önce/sonra hak revision ve etki sayısı; NOT RUN |
| S4-09 tenant-cross | A olayında B tenant | B hakkı ve sayacı değişmez | Önce/sonra hak revision ve etki sayısı; NOT RUN |
| S4-10 retry | İşlemden sonra kayıp ACK | Tek etki; unknown mutation yeniden çalışmaz | Önce/sonra hak revision ve etki sayısı; NOT RUN |
| S4-11 paused | Active olayı billing kapalı | 503 BILLING_PAUSED; ücretli hak yok | Önce/sonra hak revision ve etki sayısı; NOT RUN |
| S4-12 unknown | Bilinmeyen event tipi | Hak verilmez; inceleme | Önce/sonra hak revision ve etki sayısı; NOT RUN |
| S4-13 variant | Farklı catalog variant | Hak reddi | Önce/sonra hak revision ve etki sayısı; NOT RUN |
| S4-14 subscription | Başka subscription ID | Hak reddi | Önce/sonra hak revision ve etki sayısı; NOT RUN |
| S4-15 settlement | Active ama settlement eksik | Hak reddi | Önce/sonra hak revision ve etki sayısı; NOT RUN |
| S4-16 epoch | Revoked revision geri gelir | Monoton revision; hak geri açılmaz | Önce/sonra hak revision ve etki sayısı; NOT RUN |
| S4-17 expiry | Süresi geçmiş teklif | Yeni teklif ve açık consent gerekir | Önce/sonra hak revision ve etki sayısı; NOT RUN |
| S4-18 clock | Geri giden zaman | Fail closed; otomatik hak yok | Önce/sonra hak revision ve etki sayısı; NOT RUN |

Her fixture eventId, eventRevision, accountAlias, tenantAlias, subscriptionAlias, variantAlias, settlementState ve atUtc taşır; gerçek kimlik içermez. Yerel tekrar/ordering modelinin geçmesi signed webhook güvenliğini kanıtlamaz. İmza doğrulama, provider settlement ve idempotent kalıcı reconciler ana ekip alanıdır.
