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
| T-154 | Gizli hata panelinde `role=alert` ve hata açılışı | K05'in `auditHtml()` denetimi bu K04 HTML'i için **0 bulgu**; K05'in eski kaynak bazında `silent-error-panel` bekleyen testi kendi sahibi tarafından güncellenmeli |
| T-155 | Tekrar yükleme öncesi eski sayaçları sıfırlama, hata temizleme, `aria-busy` geçişleri | Sentetik VM başarı→503 ve 503→başarı testleri; gerçek yenile düğmesi yok, gerçek ağ **NOT_RUN** |
| T-156 | Kısa kart özeti için semantik başlık kontrolü | Admin ekranında `table/th/td` bulunmuyor; gerçek tablo başlığı ve durum hücresi incelemesi **N/A**, bir tablo eklenirse yeni kabul testi gerekir |
| T-157 | Boş, eksik, negatif, NaN/Infinity, tutarsız sayaç veya şüpheli durum alanına karşı sunum koruması | Geçersiz HTTP 200 JSON, kullanıcıya sayı/başarı gibi gösterilmiyor; bu yalnız görünüm doğrulaması, API/auth doğrulaması değildir |

## Gerekli fakat henüz yapılmamış gerçek ortam kontrolleri

- Masaüstü ve 320px/375px mobil viewport'ta yatay taşma, uzun değer ve odak gözlemi.
- Klavye/ekran okuyucuyla yükleme `role=status` ve hata `role=alert` anonsu.
- Test yöneticisi hesabıyla yetkili/403/5xx/ağ hatası durumları (gerçek hesap yok).
- Ürün API'sinin, kimlik doğrulamanın ve zero-spend politikalarının ayrı sahiplerce kabulü.

Bu testler **tarayıcı, Windows, yönetici yetkisi veya üretim doğrulaması değildir**.

## Yükleme davranışının sınırı

`web/admin.js` yalnız ekran verisi için gelen yanıtın görüntülenecek alanlarını
doğrular. Hatalı veya eksik JSON, herhangi bir sayacı kısmen güncellemeden hata
paneline düşer. Başarı/kırmızı politika belirleme eşikleri, API yolu,
`credentials: include` ve sunucu tarafı yetkilendirme değiştirilmedi. VM'deki
ikinci `load()` çağrısı, sayfaya yeni bir yeniden dene veya yenile düğmesi
eklendiği anlamına gelmez.
