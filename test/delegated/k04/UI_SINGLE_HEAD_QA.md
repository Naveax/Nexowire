# T-382 — Aynı exact HEAD'de UI regresyonu

Amaç: #539 UI test gruplarının farklı PR/SHA sonuçları toplanıp 56/56
entegrasyon PASS diye sunulmasını engellemek.

```sh
node test/delegated/k04/verify-ui-single-head.test.mjs
node test/delegated/k04/verify-ui-single-head.mjs /path/to/clean/checkout
```

İlk komutun testleri doğrulama aracına aittir. İkinci komut gerçek, temiz ve
commit'lenmiş bir **tek çalışma ağacı**nda K01–K04 kaynak testlerini sırayla
çalıştırır. Gerekli `tsx` bağımlılığının kurulu olması gerekir. Beklenen
dağılım K01=13, K02=17, K03=13, K04=13 (toplam 56). Komutlar aynı `git HEAD`,
değişmemiş worktree, sıfır FAIL/SKIP/TODO, doğru test sayıları ve başarılı
process exit kodu olmadan PASS vermez.

Ana daldaki dört test dosyası henüz bulunmuyorsa `NOT_RUN`/exit 2 verir.
Ömer'in [#1068](https://github.com/Naveax/Nexowire/pull/1068) PR'ında bunlar
entegredir; ancak #1068 açık Draft olduğundan o sürümün yeşil CI'sı ana dalın
veya fiziksel Windows/NVDA testlerinin kabulü değildir.

Bu araç salt-okunur ve offline'dır; browser/agent/hub/CORE başlatmaz. #1068,
`.github/workflows/ci.yml` veya başka sahibin dosyasını değiştirmez.
