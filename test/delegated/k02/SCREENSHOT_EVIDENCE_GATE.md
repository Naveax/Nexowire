# #539 R21/R22 — hosted ekran kabul kanıtı (T-523)

Bu çalışma otomatik olarak ekran görüntüsü üretmez. Chromium'un açılması
engelliyse **NOT_RUN** sonucunu korur. Kaynak kodu/TAP/yeşil CI ile gerçek
görsel ölçümün tamamlandığını ileri sürmez.

`browser-screenshot-evidence.mjs` kontrolünün alanları:

- `sourceSha`: test edilen tam kaynak commit SHA'sı.
- `captureState`: `not_run`, `queued`, `in_progress` veya `completed`.
- `attempted`: tarayıcı gerçekten başlatılarak capture denendi mi?
- `screenshotFile`, `screenshotSha256`, `screenshotScale`: yerel PNG adı,
  SHA-256 ve `css` ya da `device` piksel modu.
- `observedInnerWidth`, `documentScrollWidth`, `overflowIds`,
  `unknownVisible`: `mobile-dom-measurements.html` tarafından gerçek DOM'dan
  toplanacak ölçümler.
- `browserVersion`: ölçen tarayıcının sürümü.

Örnek test:

```sh
node --test --test-reporter=tap test/delegated/k02/browser-screenshot-evidence.test.mjs
```

CI owner'ının kolayca çağırabileceği açık (otomatik keşfe güvenmeyen) komut:

```sh
node test/delegated/k02/run-screenshot-evidence.mjs
```

Bu alt komut gerçek TAP'te sıfır skipped/TODO/fail, test sayısı pozitif ve
tam pass sayısı ister. Onun GitHub job içine eklenmiş olması **henüz
kanıtlanmadı**; yerel çalışması hosted PASS değildir.

## PR sadeleştirmesi / D-008

K02 [#1126](https://github.com/Naveax/Nexowire/pull/1126) içindeki
platforma göre `NOT_RUN`/`FAIL` ayrımı ile bu PR'ın PNG kanıt kontrolü
**farklı hataları** yakalar; iki modülün testleri korunarak mevcut #1138
dalına kopyalanmıştır. Açık TAP runner artık ikisini birlikte çalıştırır.
Bu yalnız kaynak taşımasıdır; ayrı #1126 PR'ının kapatılması/owner kabulü
ŞEF koordinasyonu gerektirir. CI'nin yeni MJS yollarını seçtiği yine
kanıtlanmamıştır.

Negatif eşikler:

| Gözlem | Rapor |
| --- | --- |
| Browser hiç çalışmadı / ekran görüntüsü yok, capture denenmedi | `NOT_RUN` |
| Sırada veya devam ediyor | `PENDING` |
| Capture denendi ama PNG kayboldu; yanlış checksum; dosya yolu kaçışı | `FAIL` |
| Kaynak SHA uyumsuz; eksik viewport veya tarayıcı sürümü | `UNKNOWN` |
| DOM yatay taşma veya UNKNOWN durumu görünmez | `FAIL` |
| PNG ve kayıt içsel tutarlı | `REVIEW_REQUIRED` |

Son satır **PASS değildir**: unsigned PNG + JSON kendi başına gerçek hosted
runner kimliği ve ekran görüntüsünün özgünlüğünü ispatlamaz. GitHub exact-HEAD
job/artefact bağlantısı, tarayıcı logu, viewport ve ekran görüntüsü owner
tarafından ayrıca kontrol edilmeden #485/#539 ve T-406 tamamlanmış sayılmaz.

P006 T-543: `auditIndependentScreenshotCaptures` aynı PNG SHA-256'sını
farklı capture ID'lerinde tekrar görürse ikinci sonucu
`REPLAY_UNVERIFIED` yapar. Aynı capture ID'nin yeniden kullanılması da
ayrı kanıt sayılmaz. Farklı hashlerin de gerçek tarayıcıya ait olduğu
ispatlanmış değildir; geçerli tek kayıt `REVIEW_REQUIRED` düzeyindedir.

Bu paket yalnız `test/delegated/k02/**` içindedir; Ömer'in tarayıcı, CORE,
Windows, CI veya yayın dosyalarına dokunulmadı.
