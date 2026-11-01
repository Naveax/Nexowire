# K02 responsive/zoom kabul matrisi — yalnız çevrimdışı fixture

Kaynak: `test/delegated/k02/overflow-fixtures.html` ve
`test/delegated/k02/responsive-css.test.ts`.
Son kaynak başlangıcı: `Naveax/main` `93b6df33ef58610dcfdf3584bfe774e5afa7df4d`.

## Otomatik CSS sözleşmesi

`node test/delegated/k02/responsive-css.test.ts` kontrolü şunları kapsar:

- 320/375px: 620px mobil kuralları, iki metrik sütunu, sarılan üst çubuk,
  uzun Unicode cihaz adı, URL, durum satırı, kurulum başlığı ve hata metni.
- 768px: 870px tek sütunlu cihaz/utility listesi, üç metrik sütunu.
- 1280px görünür fiziksel genişlik varsayımı için yaklaşık %200→640 CSS px,
  %400→320 CSS px yakınlaştırma sözleşmesi. Gerçek zoom davranışı buna
  indirgenemez; tarayıcı ölçümü gerekir.
- Windows yüksek kontrast `forced-colors: active` için sistem `Highlight`
  rengini kullanan görünür klavye odak halkası.
- `prefers-reduced-motion: reduce` ile dekoratif busy spinner animasyonunun
  kapanması; `BAĞLANIYOR…` metninin kalması.
- Aynı seçici/özellik için gölgelenen `display:grid` kaldırılınca beklenen
  son `display:block` değerinin 8 viewportta değişmemesi. Bu **sınırlı statik
  cascade kıyasıdır**, tam tarayıcı hesaplanmış-stil eşdeğerliği değildir.

## Gerçek tarayıcıda yapılacak ayrı kabul (şu an NOT_RUN)

1. Çalışan ürün/hesap gerekmeden yerel `overflow-fixtures.html` dosyasını
   tarayıcıda aç. Fixture salt HTML/CSS'dir; script veya ağ isteği içermez.
2. Responsive emulation ile sırasıyla 320, 375, 768 CSS piksel ve 1280px
   desktop görünümünü aç. Her birinde DevTools Console'da şu **salt-okunur**
   ifadeye bak:

   ```js
   ({ viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth })
   ```

3. 1280px desktop penceresinde tarayıcı zoom seviyesini ayrı ayrı %200 ve
   %400 yap. **Gerçek** `innerWidth` değerini kaydet; fiziksel genişlik / zoom
   sadece örnek modeldir. Yatay taşma veya odak kesilmesi varsa screenshot ile
   başarısızlık olarak işaretle.
4. `Tab` ile buton ve bağlantıları dolaş; görünür focus halkasını gözle.
   Windows yüksek kontrast/forced colors etkinleştirilebiliyorsa ayrıca dene.
5. İşletim sisteminde hareket azaltma tercihinde spinner dönmemeli; busy
   düğmesinin metni okunaklı kalmalı. `prefers-reduced-motion` değeri
   DevTools'da simüle ediliyorsa bunu **simülasyon** diye etiketle.

| Senaryo | Statik test | Gerçek viewport/klavye/screenshot |
| --- | --- | --- |
| 320px uzun cihaz adı ve URL | PASS (CSS sözleşme) | NOT_RUN |
| 375px üst çubuk ve durum satırı | PASS (CSS sözleşme) | NOT_RUN |
| 768px tek sütunlu cihaz listesi | PASS (CSS sözleşme) | NOT_RUN |
| Zoom %200 / %400 | PASS (CSS genişlik vekili) | NOT_RUN |
| Forced colors odak halkası | PASS (CSS kuralı) | NOT_RUN |
| Reduced motion busy spinner | PASS (CSS kuralı) | NOT_RUN |

`PASS` yalnız statik kaynak kontrolüdür. Gerçek test için tarih, işletim
sistemi, tarayıcı sürümü, viewport/zoom, `scrollWidth`/`innerWidth` ve
görsel dosya adı ayrı raporlanmalıdır. Üretim panelinin veya gerçek cihazın
sağlık/CORE kabulü bu matrise dahil değildir.
