# #539 R21/R22 — işletim sistemi kanıt kapısı (T-385)

Sorun: başarılı bir GitHub CI işinin, farklı işletim sistemine ait bir testi
gerçekte çalıştırdığını veya `skipped`/`todo` testlerin geçtiğini varsaymak.
İzole kanıt kapısı `platform-evidence-gate.mjs` ile bu sonuçlar ayrılır:

| Aynı SHA üzerinde doğrulanmış durum | Kapı sonucu |
| --- | --- |
| Hedef OS = çalışan OS; bitmiş test; TAP tüm testler PASS, exit 0 | `PASS` (yalnız izole çalıştırma) |
| Test gerçekten çalıştı, assertion FAIL veya exit != 0 | `FAIL` |
| Hedef Windows, Linux'ta koşulan test; skipped adım; sıfır test | `NOT_RUN` |
| TAP testleri kısmen skipped/TODO | `PARTIAL` |
| İş henüz sırada/çalışıyor | `PENDING` |
| Yanlış commit SHA, eksik TAP/exit/platform veya çelişkili TAP | `UNKNOWN` |

Çalıştırma:

```sh
node --test --test-reporter=tap test/delegated/k02/platform-evidence-gate.test.mjs
```

Örnekler gerçek alt Node test süreçlerinden pozitif, başarısız ve skipped TAP
üretir; bunları sınıflandırıcıya verir. Çalışan Linux/macOS sisteminde
Windows sonucu `NOT_RUN` kalır, gerçek Windows çalıştırması yapıldığı iddia
edilmez. `#1101` exact HEAD `3d4408e84b50e7787dec922a0332ddb35156e700`
için CI run `42410091949` 7/7 job success olsa da main CI'nin K02 yeni
`.mjs` testi için ayrı koşu adımı bulunmadığından bu testi hosted PASS
göstermez. Bu dosyadaki testlerin yerel PASS olması #539'un veya canlı
Windows/Agent/cihaz kabulünün tamamlandığı anlamına gelmez.

Kaynak alanı: yalnız `test/delegated/k02/**`; CORE/CI/source değiştirilmedi.
