# #485 / #539 — K02 T-402…T-406 ekran kabulü

Yeni `mobile-dom-measurements.html` #1068 sahibiyle aynı HTML sınıflarını ve
özellikle `#device-name`, `#status-text` Unicode/URL vakasını kullanır.
Tarayıcıda asıl CSS yüklendiğinde şu genişliklerde ayrı ayrı aç:

- 320, 375, 768 ve 1280 CSS piksel.
- 1280 fiziksel başlangıçtan %200 ve %400 yakınlaştırma (yaklaşık 640/320
  CSS piksel; gerçek `innerWidth` kaydedilmeli).
- Klavyede Tab ile `#retry` odağı ve forced-colors/reduced-motion tercihleri.

Her görünümde `window.nexowireK02Measure()` çıktısı, `innerWidth`,
`document.documentElement.scrollWidth`, `overflowIds`,
`unknownVisible`, `deviceNameWrap` ve `focusTarget` alanlarını raporlar.
`horizontalPageOverflow=true`, `overflowIds` dolu veya
`unknownVisible=false` kabul değil; ekran görüntüsü ve tarayıcı sürümüyle
yan yana değerlendirilmelidir. Kaynak statik regresyonu:

```sh
node --test --test-reporter=tap test/delegated/k02/mobile-unknown-wrap.contract.test.mjs
```

**Tekrarlanabilir eksik:** Owner [#1068](https://github.com/Naveax/Nexowire/pull/1068)
CSS blob `3923f5138caa9771c1d14c7ac422d0698de39f77` içinde
`#device-name` ve `#status-text` için `overflow-wrap:anywhere` (veya
miras alınan eşdeğeri) yok. `.device-name` dashboard kartını koruyor ama
bağlanma ekranında gerçek öğe `id="device-name"` ve `<strong>`; bu sınıfa
sahip değil. URL/Unicode için uzun kesintisiz metin dar ekranı taşır.
Eşleştirme CSS'si owner #1068'de açık olduğundan kaynak değiştirilmedi.

Güncel owner CSS üzerinde bu alt test **SKIP/NOT_FIXED**, sıkı kabul

```sh
NEXOWIRE_REQUIRE_LONG_NAME_FIX=1 node --test --test-reporter=tap test/delegated/k02/mobile-unknown-wrap.contract.test.mjs
```

ile **RED** olur; owner'ın güncellemesinden sonra tüm testlerin gerçek
PASS olması beklenir. Eski main CSS bloğunda mobil kaynak testleri de SKIP,
geçmiş sayılmaz. Bu sayfadaki scriptin varlığı gerçek ekran görüntüsü veya
Windows klavye/okuyucu kabulü değildir; onlar **NOT_RUN**.

T-401 exact CI: [#1126](https://github.com/Naveax/Nexowire/pull/1126)
head `332e211e8894bfa6222ecc9c0e03b89463b8acd0` için run
`42412128181` tamamlandı: 7/7 hosted jobs **success**. Ancak main
`.github/workflows/ci.yml` ve `npm test` hiçbir yeni K02 `.mjs` testini
çağırmıyor. CI job success ≠ bu testlerin hosted PASS olması; K13/owner
explicit runner bekleniyor. #539 ve #485 issue kapatılmadı.
