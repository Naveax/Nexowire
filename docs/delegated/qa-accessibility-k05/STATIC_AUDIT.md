# K05 — Web erişilebilirlik statik QA ve gerçek ortam kanıt boşlukları

Tarih: 2026-11-01 (Europe/Istanbul)

Kaynak: `Naveax/Nexowire` `main` `93b6df33ef58610dcfdf3584bfe774e5afa7df4d`

Kapsam: yalnız `web/index.html`, `web/connect.html`, `web/admin.html`, `web/custom-usage-consent-preview.html` kaynak HTML'i; hata mesajları için ilgili JS dosyalarında sınırlı salt-okunur kontrol.

## Tekrarlanabilir komutlar

Repo kökünde, Node.js 22+ ile ve **npm paketi yüklemeden**:

```sh
node test/delegated/k05/audit-html.test.mjs
node test/delegated/k05/dynamic-id-contract.test.mjs
node scripts/delegated/k05/audit-html.mjs
```

- İlk iki komut toplam 24 otomatik olumlu/olumsuz regresyonu çalıştırır (20 HTML/hata, 4 dinamik kart ID kaynak sözleşmesi). Bu testlerin PASS olması canlı arayüzün erişilebilirlik kabulü anlamına gelmez.
- Üçüncü komut mevcut statik sayfa bulgularını sayar; bir bulgu varsa **exit code 1** döner. Gerçek bir uyarıyı gizlemek için ignore/waiver uygulanmadı.
- CLI yalnız kaynak HTML etiketleri, ID bağları, ad/label, etkileşimli native türler, `aria-live`, hata panelleri ve sınırlı hata JS `textContent` sözleşmesini denetler. HTML parser'ı genel amaçlı değildir; malformed HTML ve JavaScript ile oluşan gerçek DOM için tarayıcı gerekir.
- Genel `npm test` komutuna veya CI workflow'una dokunulmadı; mevcut repo komutu `.test.ts` dosyalarını hedefler. K13'ten bağımsız runner entegrasyonu istenmeli.

## Görev/kanıt matrisi

| Görev | Üretilen kanıt | Gerçekte test edilmeyen |
| --- | --- | --- |
| T-025 — label/accessible name | Explicit ve wrapping label, `aria-label`, `aria-labelledby`, placeholder-only, boş action, `for` ve duplicate ID negatifleri | Render edilmiş JS cihaz kartları, browser accessibility tree |
| T-026 — klavye regresyonu | Native/ARIA widget, `onclick` ve `tabindex` kaynak negatifleri; connect tablist'in `keydown` ve Arrow/Home/End kaynak kontrolü | Gerçek Tab/Shift+Tab/Space/Enter/ok tuşları, fokus geri dönüşü |
| T-027 — canlı durum | `status`, `alert`, geçersiz/kapalı `aria-live`, eksik referans ve sessiz hata paneli negatifleri | Ekran okuyucu seslendirme sırası, canlı asenkron DOM güncellemeleri |
| T-028 — hata/metin ID | Panel/mesaj iç içeliği, message `textContent` ve `innerHTML` regresyon negatifi, HTML ID eşleşmeleri | Sunucu hata akışının gerçek kullanıcı hesabıyla çalışması |
| T-029 — dokunma/viewport | 4 sayfada `width=device-width` varlığı; CSS'de mobil media ve `:focus-visible` kaynak sözleşmesi | Gerçek 24/44 CSS px hedef boyutları, yakınlık, pinch/zoom, mobil taşma |
| T-030 — kanıt matrisi | Bu dosya; kalan testler ve sahipler aşağıda | Gerçek browser/Windows/Android/VoiceOver/NVDA kabulü |
| T-136 — fixture path | POSIX/Windows/UNC relatif etiket, kök dışı/geçiş/dengesiz ad için negatifler; CLI göreli dosya etiketi | Windows işletim sistemi dosya semantiğinin kendisi |
| T-158 — tekrarlı live bölge | İki aynı `status` metni veya iç içe live bölge negatifleri | Gerçek çift seslendirme ölçümü |
| T-159 — uzun Unicode label | Uzun Türkçe NFD/Unicode boşluk label pozitif, yalnız görünmez karakter ad negatifleri | Tarayıcı adı hesaplama algoritması |
| T-160 — disabled kontrol | Devre dışı düğmede ad zorunluluğu; yanlış gizli-focus sonucunu engelleme | Gerçek Tab/focus sırası |
| T-161 — dinamik panel ID | `web/app.js` şablonu içinde sabit tekrarlanan ID negatifi; indexed panel ID/aria-controls source sözleşmesi | Canlı JS DOM ve sunucu duplicate cihaz nesnesi |
| T-162 — owner devri | `OWNER_HANDOFF.md`: K01/K02/K04/K03 takip ve yeniden üretim bağlantıları | Diğer sahiplerin çözümünün tamamlanması |

## Açık, tekrar üretilebilir kaynak bulgusu

1. **K04'ün sahibi olduğu `web/admin.html`**: `#admin-error` sınıfı `error-panel`, ancak `role="alert"`, `role="status"` veya `aria-live` bulunmuyor. Kullanıcıya gösterilen hata, ekran okuyucu tarafından otomatik bildirilmeyebilir. `node scripts/delegated/k05/audit-html.mjs` `silent-error-panel` bulgusunu döndürür. **K05 bu HTML'i değiştiremez**; K04 karar vermeli.
2. **K01'in sahibi olduğu `web/connect.html`**: `#install-content` üst kapsayıcısı `aria-live="polite"` iken altındaki `#copy-status` ayrıca `role="status" aria-live="polite"`. İç içe canlı bölge kaynak denetimi `nested-live-region` döndürür. Çift seslendirme olasılığı vardır; gerçek NVDA/VoiceOver kanıtı yoktur. K01 yapısal düzeltme/karar sahibidir.
3. **K02 CSS değerlendirmesi**: `web/styles.css` içinde `.filter-button,.layout-button` `min-height:36px`, `.connect-back,.connect-cancel` `min-height:39px` ve diğer küçük kontrol örnekleri var. Tek başına bu deklarasyonlar erişilebilirlik ihlali kanıtı değildir (genişlik, aralık ve istisnalar önemlidir). Mobil gerçek hedef boyutları ve yakınlıkları ölçülmeli; değişiklik gerekiyorsa yalnız K02 yazmalı.
4. **K03 dinamik cihaz kartları**: `web/app.js` içinde `row.innerHTML` ile üretilen UI'nin erişilebilirlik ağacı bu statik scanner tarafından analiz edilmez. Yeni kaynak denetimi `pcPanel.id` ve `aria-controls` sözleşmesini kontrol eder; ancak başarılı tarayıcı testi veya cihaz kartı erişilebilirlik PASS'i ilan edilmez.

## Gerçek tarayıcı/cihaz kabul matrisi — NOT_RUN

| Sahne | Senaryo / beklenti | Durum |
| --- | --- | --- |
| Desktop Chromium/Firefox 1280px | Bağlanma/ana/admin sayfaları; Tab, Shift+Tab, Enter, Space, görünür fokus | NOT_RUN |
| Connect tablist | Windows/macOS/Linux ok tuşları, Home/End, seçili sekme/panel eşleşmesi ve fokus | NOT_RUN |
| Connect başarısız ağ | Hata panelinin duyurulması, yeniden deneme, disabled ve loading | NOT_RUN |
| Admin hata | Gerçek rol düzeltmesi sonrası NVDA/VoiceOver'da hata seslendirmesi | NOT_RUN |
| 768px ve 375px viewport | %200/%400 zoom, yatay taşma, uzun Türkçe metin ve hata mesajları | NOT_RUN |
| Dokunmatik | Tüm etkileşimli hedeflerin görünür ölçüleri/mesafeleri ve yanlış dokunma riski | NOT_RUN |
| Dinamik cihaz listesi | 0/1/çok cihaz; kapalı/açık erişim paneli, label, odak döngüsü, canlı statü | NOT_RUN |
| Windows 11 ekran okuyucu | NVDA + Chromium/Edge, çift duyuru ve giriş sırası | NOT_RUN |

Gerçek sunucu, kullanıcı oturumu, OAuth/Cloudflare, Broker veya güvenlik izni gerektiren herhangi bir süreç bu QA turunda başlatılmadı. Testler Web UI için yalnız **statik kaynak regresyonu** sağlar.
