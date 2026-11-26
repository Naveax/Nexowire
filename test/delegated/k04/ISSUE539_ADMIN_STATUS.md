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

## 19 Kasım / yeni negatif: eşzamanlı yanıtların sıra tersliği

Owner #1160 `81028bf643e3dc3cb5b0ab3f9c609c239732a413` içindeki
`web/admin.js` blob `c77b46d012f95039f3749edc6336fe43c2d616f6`
iki `load()` çağrısı çakıştığında **son başlayan isteğin** sonucu ekranda
kalacak biçimde korunmuyor. Bu sadece Node22 offline VM'de zorlanmış
çakışma senaryosudur; mevcut ürün arayüzünde iki çağrının gerçekten aynı
anda oluştuğu ve gerçek admin/Windows olayı **kanıtlanmadı**.

Ölçümler: önce eski 200 geciktirildi, yeni 403 tamamlandı, sonra eski 200
geldi. Sonuç `Yetki yetersiz` -> `Zero-spend aktif`, eski KPI geri döndü,
uyarı paneli açık kaldı. Ters sırada eski 403 geç tamamlanınca başarılı
200'ün üstüne `Yetki yetersiz` yazdı. İki vaka da kaynak kabulünde
`0/2 PASS, exit 1` (beklenen RED). Bu bir auth bypass kanıtı değildir.

```sh
node --test test/delegated/k04/admin-concurrent-response.test.mjs
node test/delegated/k04/admin-concurrent-response.mjs /exact/owner/web/admin.js
```

İlk komutta 5/5 fixture PASS (guarded/unguarded/credential negatifleri).
İkinci komut owner blob'unda exit1; testte `fetch` tümüyle sentetik.
Owner olası en küçük düzeltme: monoton istek sıra numarasıyla yalnız son
`load()` çağrısının fetch/JSON tamamlanmasından sonraki ekran yazma, hata
ve `aria-busy` değişikliklerine izin ver. Gerçek izin/oturum/API davranışına
dokunmadan kaynak yeniden test edilmeli. K04 yalnız test/docs yoluna yazdı;
owner `web/admin.js` veya ana `ci.yml` değiştirilmedi. Hosted exact test
keşfi ve fiziksel admin/browser/Windows **ayrı NOT_RUN**.

## P013 W-599…W-604 — last-request-wins taslak ve gerçek CI ayrımı (20 Kasım)

- Güncel owner [#1160](https://github.com/Naveax/Nexowire/pull/1160) source HEAD
  `06a9df635b6731c02170ca3583ba6de2b8b909dd`; `web/admin.js` blob
  **`c77b46d012f95039f3749edc6336fe43c2d616f6`** önceki RED ile eş.
- Üç deterministik eşzamanlı durum: eski HTTP 200 sonra yeni HTTP 403,
  eski HTTP 403 sonra yeni HTTP 200 ve *ilk fetch dönmüş ama ilk
  `response.json()` hâlâ bekliyorken* yeni HTTP 403. Gerçek owner kaynak
  üçünde de **0/3 PASS**. Source değiştirmeden beş korumalı/korumasız
  test ile daha önce test edilmeyen JSON gecikmesi için üç negatif/pozitif
  kontrol eklendi; V8 VM-uyumlu hafızaiçi koşu **8/8 PASS**, ürün **0/3**.
  Bu V8 koşusu `node --test` veya hosted CI kanıtı değildir.

Owner için **öneri, uygulanmış kaynak düzeltmesi DEĞİL**: yalnız `web/admin.js`
içindeki `load()` durum yazımını son isteğe sınırla. Aşağıdaki parça
source SHA `c77b46...` üstünde hafızaiçi uygulanıp üç senaryoda **3/3**
geçti; sözleşme/gerçek browser/Node22-24 CI kabulü henüz yok.

```diff
+let activeRequest = 0;
 async function load() {
+  const requestId = ++activeRequest;
   showLoading();
   let httpStatus = null;
   try {
     const response = await fetch('/api/v1/admin/overview', {
       credentials: 'include',
       headers: { Accept: 'application/json' },
     });
+    if (requestId !== activeRequest) return;
     if (!response.ok) {
       httpStatus = response.status;
       throw new Error('HTTP ' + response.status);
     }
     const data = await response.json();
+    if (requestId !== activeRequest) return;
     if (!isOverview(data)) throw new Error('Yönetim özeti eksik veya geçersiz');
     // unchanged KPI / status rendering
   } catch (error) {
+    if (requestId !== activeRequest) return;
     // unchanged denial mapping and error display
   } finally {
-    $('admin-metrics').setAttribute('aria-busy', 'false');
+    if (requestId === activeRequest) $('admin-metrics').setAttribute('aria-busy', 'false');
   }
 }
```

**Neden üç ayrı guard?** İlk `await fetch` sonrası kontrol eski HTTP
yanıtını, `await response.json` sonrası kontrol geç ayrıştırılan eski
başarıyı, `catch/finally` guard'ları eski hata veya `aria-busy` temizliğini
engeller. Bu yalnız UI presentation çözümüdür; gerçek yetki veya sunucu
denetimi değişmez. Owner uygulamadan önce çözümü kendi QA/CI'sında doğrular.

**CI W-602:** #1104 `90f28d7867212562551c2de388161606bde3ae2c`
[run 44609496987](https://github.com/Naveax/Nexowire/actions/runs/44609496987)
`completed/success` (7 job success); Node22/24 job logu `135862102306`/
`135862102208` tam tarandığında `admin-concurrent-response.test.mjs`,
`admin-denial-redaction.test.mjs`, `issue539-admin-status-probe.test.mjs`
**çağrılmamış**. Bu üç nested MJS için **HOSTED_NOT_RUN**; genel green
kabul değildir. Yeni HEAD'e ait otomatik CI ayrıca sonuçlanmadan PASS değil.

Gerçek iki-istek çakışmasının normal kullanıcı ekranında tetiklenebilirliği,
fiziksel Windows/admin login/browser/NVDA, protected owner Work-PC
**NOT_RUN**. #539/#1006 issue close, #1160 kaynak değişimi ve yeni CI
test callsite owner/ŞEF kararına bırakılır.
