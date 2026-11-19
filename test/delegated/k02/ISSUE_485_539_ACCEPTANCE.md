# K02 issue #485 / #539 R11 — 7 Kasım kaynak ve tarayıcı kapısı

## Kaynak karşılaştırması (salt okunur)

| Kaynak | Exact SHA / sonuç |
| --- | --- |
| `Naveax/main` | `4e7db16f4233048a956664bef6b607781eb63fb7` |
| Açık K02 PR | [#1010](https://github.com/Naveax/Nexowire/pull/1010) @ `3f6a226e4244d3a599d9631adf69bb40bf1f4c92` (Draft, unmerged) |
| Owner UI entegrasyonu | [#1068](https://github.com/Naveax/Nexowire/pull/1068) @ `94d38799e9e4b50fe84f7924e6fc84f90aeba090` (Draft, unmerged) |
| `web/styles.css` | `main` blob `d45d9445ba84361648f2544db243ff975b9ab21b`; #1010 ve #1068 blob **aynı** `3923f5138caa9771c1d14c7ac422d0698de39f77` |
| K02 fixture ve zoom matrisi | #1010 ve #1068 blob SHA'ları birebir aynı |
| K02 `responsive-css.test.ts` | #1068, #1010'dan tek yerde `] as const)` ile ayrılıyor; aynı dosya değil, davranış tekrar test edilmeli |

**Karar:** Main henüz K02 mobil CSS değişimini içermiyor. #1068 bu dört K02
dosyasını taşıyor. Bu yüzden yeni bir CSS kaynak commit'i yapılıp #1068 ile
çakışma oluşturulmadı. Yeni bağımsız regresyon yalnız `test/delegated/k02/`
içinde tutuldu. Owner'ın #1068 testindeki tek tip düzeltmesi geri alınmamalı.

## İzole testin iki açık çalışma modu

Yeni `issue-485-539-ui.contract.test.mjs` CSS dosyasının **Git blob SHA**
değerini kullanır. Tam eski main blobunda hiçbir şeyi sahte PASS saymaz;
entegrasyon isteyen beş test `SKIP` olur. Başka CSS sürümünde varsayılan
olarak tüm negatif sözleşmeler gerçekten çalışır ve hata durumunda FAIL verir.

```bash
# Bu SHA'da kalan eski main: 1 PASS / 5 SKIP (kapsam henüz yok)
node test/delegated/k02/issue-485-539-ui.contract.test.mjs

# Owner #1068 CSS'si ayrı yerel dosyadaysa onun yolunu açıkça ver:
# beklenen: 6/6 PASS, 0 SKIP
NEXOWIRE_CSS_PATH=/absolute/path/to/owner-web-styles.css node test/delegated/k02/issue-485-539-ui.contract.test.mjs

# Bilinçli negatif kapı: eski main'de entegrasyon gerekliymiş gibi zorla;
# FAIL beklenir, üretim CI komutu değildir.
NEXOWIRE_REQUIRE_UI_INTEGRATION=1 node test/delegated/k02/issue-485-539-ui.contract.test.mjs
```

İzole yerel kanıt (Node v24.22.1):

- K02/#1068 aday CSS blobu ile **6/6 PASS**, exit 0.
- Main'in eski CSS blobuyla **1 PASS, 5 SKIP**, exit 0.
- Eski blob + `NEXOWIRE_REQUIRE_UI_INTEGRATION=1`: **beklenen RED**, exit 1.

Bu testler 320/375/768px statik cascade, uzun Unicode cihaz adı/URL/durum
satırı, forced-colors focus, yaklaşık %200/%400 zoom CSS genişlik vekili ve
reduced-motion spinner sözleşmesi içindir. Bunlar gerçek ekran ölçümünün yerini
almaz ve #485'in kurucu/OAuth/Agent kabulünü test etmez.

## T-266 gerçek tarayıcı kapısı

Yerel Chromium `156.0.8078.79` denendi. Headless screenshot başlatma
`socket() failed: Operation not permitted (1)` ile exit 134 verdi.
Bu, tarayıcı kabulü **BLOCKED / NOT_RUN** demektir; screenshot üretilmedi.

Owner #1068 kaynak kodu ana dala alındıktan sonra, gerçek izinli tarayıcıda
`overflow-fixtures.html` için 320, 375, 768 ve 1280px görünümü; %200/%400
zoom, yatay `scrollWidth > innerWidth`, Tab odağı, Windows forced-colors ve
reduced-motion durumları ayrı çalıştırılmalı. Ekran ve cihaz kanıtı yokken
#485 veya #539/R11 kapatılmamalı. CI exact SHA ve owner kabulü ayrıca gerekir.
