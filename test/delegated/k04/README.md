# K04 — yönetim özeti erişilebilirlik kanıtı

Kapsam: yalnız `web/admin.html`, `web/admin.js` sunum durumları ve bu klasördeki
çevrimdışı testler. Yönetici yetkilendirmesi, oturum, ağ uç noktası ve sunucu
iş mantığı değiştirilmedi.

| Görev | Çıktı | Kanıt ve sınır |
| --- | --- | --- |
| T-019 | Dört KPI için başlık ve kart-etiket ilişkileri; metrik bölümü ismi | `node --test test/delegated/k04/admin-a11y.test.mjs`; sayfada gerçek `<table>` yok, dolayısıyla sütun başlığı incelemesi uygulanmaz |
| T-020 | İlk yükleme `aria-busy`, gizli hata paneli, başarı/ağ-hatası/HTTP-hatası DOM geçişleri | Sentetik DOM/VM testleri; canlı admin hesabı **NOT_RUN** |
| T-021 | Yalnız yönetim ekranına ait 2 sütun / dar ekranda 1 sütun ve uzun metin satır kırma | CSS kaynak-regresyonu; gerçek mobil tarayıcı ve screenshot **NOT_RUN** |
| T-022 | `role=status` ile kısa yükleme/sistem durumu, hata için `role=alert` | Statik/VM testleri; ekran okuyucuyla canlı anons kontrolü **NOT_RUN** |
| T-023 | UI değişikliğinin tek okuma isteğini ve `credentials: include` sözleşmesini koruması | Sentetik negatif test; auth/admission sunucu testlerinin yerine geçmez |
| T-024 | Kabul sınırı ve ayrı gerçek-admin kontrol listesi | Bu matris; gerçek hesap kabulü **NOT_RUN** |

## Gerekli fakat henüz yapılmamış gerçek ortam kontrolleri

- Masaüstü ve 320px/375px mobil viewport'ta yatay taşma, uzun değer ve odak gözlemi.
- Klavye/ekran okuyucuyla yükleme `role=status` ve hata `role=alert` anonsu.
- Test yöneticisi hesabıyla yetkili/403/5xx/ağ hatası durumları (gerçek hesap yok).
- Ürün API'sinin, kimlik doğrulamanın ve zero-spend politikalarının ayrı sahiplerce kabulü.

Bu testler **tarayıcı, Windows, yönetici yetkisi veya üretim doğrulaması değildir**.
