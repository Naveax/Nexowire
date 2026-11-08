# #539/R11/R18 — admin görünüm durumları, kaynak doğrulaması

Bu dosya ve aynı dizindeki probe yalnız kaynak JS'yi sentetik `fetch` ile çalıştırır;
gerçek yönetici hesabı, token, cihaz, CORE veya servis çağrısı yapmaz.

## Yeniden üretim

```sh
node test/delegated/k04/issue539-admin-status-probe.test.mjs
node test/delegated/k04/issue539-admin-status-probe.mjs /path/to/checked-out/web/admin.js
```

İlk komut denetleyicinin pozitif/negatif birim testidir. İkinci komut **ürün
kaynağı kabul testidir**: bulunan hata varsa `exit 1` verir; bu durum PASS değildir.

Altı davranış: geçerli yanıt, negatif sayaç, eksik JSON, 401, 403, 503.
401/403 için `Offline` yazması **yanlış neden** gösterimidir; taşıma kesintisiyle
yetki reddi birbirinden ayrılmalıdır. Bu tespit, sunucu yetkilendirmesinin
değiştirilmesini önermez.

## 7 Kasım kaynak gözlemi (canlı ortam değil)

- `main@4e7db16f`, `web/admin.js` blob `cde1c940ab06b8993f8a4ef4597f40a638179f07`:
  **3/6** sözleşme; negatif `users.total=-1` yeşil başarı gibi yazıldı,
  401/403 `Offline` gösterildi. Probe `exit 1` (beklenen açık bulgu).
- Owner `#1068@94d38799`, `web/admin.js` blob
  `6d179c1840a628b4050a00d8dd6a24c7f011d907`:
  **4/6** sözleşme; negatif sayaca karşı koruma mevcut, fakat 401/403 hâlâ
  `Offline` gösteriliyor. Probe `exit 1`. Owner sürümünün eş blob'u
  K04 `#1015@2d448f69` dalında da bulunuyor.
- Denetleyicinin kendi 5 pozitif/negatif birim testi **5/5 PASS**. Bu, yukarıdaki
  iki ürün sürümünün başarısız denetimini PASS'e çevirmez.

**Önerilen en küçük owner düzeltmesi:** yalnız hata sunumu içinde HTTP 401/403
yanıtını kimlik/yetki reddi olarak açıkça adlandır; bağlantı kopması/5xx ve
eksik-JSON durumunu bundan ayır. API, oturum ve erişim denetiminin işleyişini
değiştirme. Aynı sürüm üzerinde altı test ve owner'ın mevcut 13 testi yeniden
çalıştır; sonra gerçek yetkili/yetkisiz admin hesabında doğrula.

## Sahiplik ve kabul sınırı

- 7 Kasım upstream `main`: `4e7db16f4233048a956664bef6b607781eb63fb7`.
- Owner [#1068](https://github.com/Naveax/Nexowire/pull/1068) admin kaynak
  dosyalarını içerir. K04 bunlara çakışmalı yazma yapmaz; bu test ayrı kalır.
- K04 [#1015](https://github.com/Naveax/Nexowire/pull/1015) değişiklikleri
  owner #1068'e exact blob olarak taşınmış, henüz hedef main'e girmemiştir.
- Yalnız bağımsız `test/delegated/k04/**` dosyaları eklenir.
- Gerçek 320/375px browser, NVDA, yetkili/403 hesap, Windows ve canlı API:
  **NOT_RUN**. Kaynak/VM testleri bunların yerine geçmez.
