# S5-01 — Mevcut araç envanteri

31 Ekim 2026 | Base main `a19a228dc6f19fd484cf935e941a00ea625233f8` | Dal `docs/delegated-s4-s5-20261031`
Kanıt türü: source-only / dokümantasyon; fiziksel veya üretim kabulü değildir.

Bu dosyada listelenen mevcut araçların hiçbiri çalıştırılmadı veya kopyalanmadı. Kaynakları statik okundu; alt bağımlılıklar canlı kapasite kanıtı değildir.

| Kaynak | Amaç / çıktı / metrik | Veri ve ağ | Yan etki / bağımlılık / güvenli koşul |
|---|---|---|---|
| [scripts/bench-s5-owner-quota-local.ts](../../scripts/bench-s5-owner-quota-local.ts) | SQLite reservation; stdout JSON; latency, debit, WAL | Sentetik auth; ağ yok | Node SQLite; geçici WAL oluşturur/siler; izole lab |
| [scripts/bench-s5-loopback-ws-capacity.ts](../../scripts/bench-s5-loopback-ws-capacity.ts) | WS/SQLite admission; latency, queue, CPU/RSS, fairness | Gerçek loopback WS, sahte kimlik; remote yok | ws + SQLite + fixture SQL; geçici DB/socket; açık izin gerekir |
| [scripts/bench-s5-loopback-reconnect-storm.ts](../../scripts/bench-s5-loopback-reconnect-storm.ts) | Replay/churn; open/close, queue ve p50/95/99 | Gerçek loopback WS; bellek ID seti | ws; ephemeral port; gerçek grant/ledger değil; açık izin |
| [scripts/bench-s5-bounded-stream-transfer.ts](../../scripts/bench-s5-bounded-stream-transfer.ts) | TCP byte/hash/throughput, RSS/CPU; fonksiyon sonucu | Gerçek loopback byte; Artifact API yok | Node net; 1GiB sınırı; CPU/RAM/socket; açık izin |
| [scripts/bench-s5-http-mcp-isolation.ts](../../scripts/bench-s5-http-mcp-isolation.ts) | 4 büyük upload / küçük route latency, 413/429 | Loopback HTTP sentetik MCP fixture | Node http; port/RAM; gerçek Hub parser değil; açık izin |
| [scripts/report-s5-cost-matrix.ts](../../scripts/report-s5-cost-matrix.ts) | projectS5Matrix stdout; varsayımsal maliyet | Saf model; ağ yok | src/ops cost-envelope; gömülü varsayımları güncel fiyat sanma |
| [scripts/report-s5-fairness-do-risk.ts](../../scripts/report-s5-fairness-do-risk.ts) | DO projeksiyon ve fairness stdout | Saf sentetik; ağ yok | src/ops DO/fairness; account invoice değildir |
| [scripts/report-s5-staging-readiness.ts](../../scripts/report-s5-staging-readiness.ts) | Yerel manifest denetimi; stdout; exit 2 fail closed | Operatör importu; ağ yok | src/ops evidence; max 1MiB JSON; bağımsız doğrulama değil |
| [scripts/report-s5-measured-scenarios.ts](../../scripts/report-s5-measured-scenarios.ts) | 16/32/64/100/256 fixture; docs/reports JSON | Gerçek loopback WS; sentetik hesap | Git/OS/ws/SQLite; mevcut kanıt yoluna wx yazar; çalıştırma izni yok |
| [scripts/report-s5-bounded-reconnect.ts](../../scripts/report-s5-bounded-reconnect.ts) | 120 x 3 churn; docs/reports JSON | Loopback WS; cloud alanları null | Git/OS/ws; wx dosya ve socket; açık izin |
| [scripts/report-s5-bounded-stream.ts](../../scripts/report-s5-bounded-stream.ts) | 221KiB, >256MiB, 1GiB; docs/reports JSON | Loopback TCP; native/hosted değil | ack flag, 2GiB free RAM; socket CPU; açık izin |
| [scripts/report-s5-http-mcp-isolation.ts](../../scripts/report-s5-http-mcp-isolation.ts) | 4MiB / 38MiB upload fixture; JSON | Loopback HTTP; remote yok | ack flag, 3GiB RAM; wx docs/reports; açık izin |
| [scripts/s5-soak-acceptance.ts](../../scripts/s5-soak-acceptance.ts) | Yerel metadata gate; stdout; exit 2 | Ağ/socket yok; gerçekliği doğrulamaz | Node; max 10MB; 1440 sample ve 24h metadata |
| [scripts/s5-soak-local-runner.ts](../../scripts/s5-soak-local-runner.ts) | Dakikalık loopback diagnostic; NDJSON | Resetlenen fixture; sürekli soak değil | ws/SQLite; dosya/port, uzun bekleme; >5dk ack; çalıştırma izni yok |

## Mevcut testler

| Dosya | Kapsam | Ağ / yan etki / koşul |
|---|---|---|
| [test/s5-bounded-stream-transfer.test.ts](../../test/s5-bounded-stream-transfer.test.ts) | S5/#588 221-KiB real bytes cross localhost TCP and roundtrip SHA matches; S5/#588 two independent real loopback byte streams have bounded concurrency and buffers; S5/#588 an oversized payload, >2 streams, zero-byte chunk and unbounded deadlines are refused | Node test runner, tsx; loopback socket; yalnız açık izinli lab; bu çalışmada NOT RUN |
| [test/s5-http-mcp-isolation.test.ts](../../test/s5-http-mcp-isolation.test.ts) | four overlapping bounded HTTP uploads do not starve small synthetic MCP route; HTTP fixture refuses fifth source-concurrency slot and unbounded workload | Node test runner, tsx; loopback socket; yalnız açık izinli lab; bu çalışmada NOT RUN |
| [test/s5-ingress-concurrent-rate.test.ts](../../test/s5-ingress-concurrent-rate.test.ts) | S5 4 real SQLite writers enforce a single 600 per rolling-minute provider scope; S5 4 writers fail closed at a lower 64/rolling-minute owner setting; S5 rejects unsafe parallel workload dimensions; S5 global shared 600 budget does NOT itself guarantee per-tenant fairness | Node test runner, tsx; SQLite temp DB / worker; izole lab; bu çalışmada NOT RUN |
| [test/s5-loopback-reconnect-storm.test.ts](../../test/s5-loopback-reconnect-storm.test.ts) | S5 120 loopback WS users reconnect three times without duplicate tool admission; S5 tiny queue induces explicit backpressure rather than silent success; S5 reconnect fixture rejects unbounded load dimensions | Node test runner, tsx; loopback socket; yalnız açık izinli lab; bu çalışmada NOT RUN |
| [test/s5-loopback-ws-capacity.test.ts](../../test/s5-loopback-ws-capacity.test.ts) | S5 loopback socket capacity: ; S5 isolation vs one shared quota: other tenant must retain allowance; S5 bounded queue overload reports backpressure and never overspends; S5 existing SQLite rolling 600/min meter: boundary, replay ingress, rollover and shared scope; S5 defaults reject unsafe workload expansion and network target options | Node test runner, tsx; loopback socket; yalnız açık izinli lab; bu çalışmada NOT RUN |
| [test/s5-protected-concurrent-writers.test.ts](../../test/s5-protected-concurrent-writers.test.ts) | S5 four independent SQLite writers cannot steal a late quiet tenant share; S5 mismatched operator share policy on shared DB fails closed | Node test runner, tsx; SQLite temp DB / worker; izole lab; bu çalışmada NOT RUN |
| [test/s5-soak-acceptance.test.ts](../../test/s5-soak-acceptance.test.ts) | S5 30-second or fabricated 24h proof can never pass 24h metadata gate; S5 structurally complete fixture passes metadata, never production acceptance; S5 fabricated duplicate timestamps, counter resets and gaps fail closed; S5 invalid negative counters / hashless provider claims are rejected | Node test runner, tsx; sentetik metadata/saf model; dış ağ çağrısı görülmedi; bu çalışmada NOT RUN |
| [test/scale-s5-chunk-receipt-audit.test.ts](../../test/scale-s5-chunk-receipt-audit.test.ts) | 221 KiB uses four bounded 64KiB receipts with no fake verified native effect; 1GiB 16384 synthetic receipt offsets checked with constant sampled memory; source/target/tenant epoch, incorrect hash, stale offset and partial body fail closed; transfer ownership and unsafe 64bit JS integer targets rejected | Node test runner, tsx; sentetik metadata/saf model; dış ağ çağrısı görülmedi; bu çalışmada NOT RUN |
| [test/scale-s5-cost-envelope.test.ts](../../test/scale-s5-cost-envelope.test.ts) | 100 modest synthetic users are only nominally inside Free numeric budgets; 1000 and 10000 users require more than free worker/D1 budget; transport 600/min and 850k/day cannot imply successful calls; invalid budgets and zero hosted ingress are blocked | Node test runner, tsx; sentetik metadata/saf model; dış ağ çağrısı görülmedi; bu çalışmada NOT RUN |
| [test/scale-s5-durable-object-cost.test.ts](../../test/scale-s5-durable-object-cost.test.ts) | S5 DO hibernation can make idle duration zero, but connection and message requests remain; Two nonhibernating DOs exhaust free 13000 GB-s/day even at low requests; S5 DO cost rejects impossible or overflowed WSS assumptions | Node test runner, tsx; sentetik metadata/saf model; dış ağ çağrısı görülmedi; bu çalışmada NOT RUN |
| [test/scale-s5-fairness-analysis.test.ts](../../test/scale-s5-fairness-analysis.test.ts) | S5 normalized Jain detects starvation hidden by total global request count; S5 rate meter can starve a quiet tenant when another arrives first; S5 Jain normalization does not penalize legitimate unequal demand; S5 fairness rejects mismatch, negative counters and empty samples | Node test runner, tsx; SQLite temp DB / worker; izole lab; bu çalışmada NOT RUN |
| [test/scale-s5-protected-admission.test.ts](../../test/scale-s5-protected-admission.test.ts) | S5 baseline global budget starvation reproduced with current first-come meter; S5 300/300 strict isolated shares protect late-arriving quiet tenant; S5 95/5 skew weighted plan protects minimum quiet user share; S5 cross tenant forged principal, replay collision and unknown plan never grant; S5 exact rolling boundary and backward clock fail closed; S5 shared-file SQLITE_BUSY denies without phantom admission; S5 invalid protected-share plans are rejected | Node test runner, tsx; SQLite temp DB / worker; izole lab; bu çalışmada NOT RUN |
| [test/scale-s5-provider-meter-evidence.test.ts](../../test/scale-s5-provider-meter-evidence.test.ts) | Cloudflare snapshots return counter DELTAS, no verified native completion or bill; Unknown DO/D1 data stay null and never represent a zero bill; Cross resource, backwards clock, decreasing and invalid meter counters fail | Node test runner, tsx; sentetik metadata/saf model; dış ağ çağrısı görülmedi; bu çalışmada NOT RUN |
| [test/scale-s5-resource-reconciliation.test.ts](../../test/scale-s5-resource-reconciliation.test.ts) | S5 500 quota reservations cannot claim any verified native completion; S5 operator claimed 99 completions remain unverified, no auto promotion; S5 rejects more outcomes than reserved and forged counter values | Node test runner, tsx; sentetik metadata/saf model; dış ağ çağrısı görülmedi; bu çalışmada NOT RUN |
| [test/scale-s5-staging-acceptance.test.ts](../../test/scale-s5-staging-acceptance.test.ts) | Old 360 cumulative reconnects with peak 21 cannot count as >100 WSS; Self-provided imaginary full evidence NEVER becomes staging or production PASS; Missing staging authorization and real native effects fail closed; Paid resources, request burst, session cap and missing owner approval denied; Invalid latency, inconsistent quota and missing artifact hashes denied | Node test runner, tsx; sentetik metadata/saf model; dış ağ çağrısı görülmedi; bu çalışmada NOT RUN |

## İlgili belgeler ve kayıtlar

- [SCALE_V2_S5_CONCURRENT_OWNER_SQLITE.md](../SCALE_V2_S5_CONCURRENT_OWNER_SQLITE.md): tarihli kaynak iddiası; bu oturumun ölçümü değildir.
- [SCALE_V2_S5_FAIRNESS_RATE_DO_COST_FOLLOWUP_20261018.md](../SCALE_V2_S5_FAIRNESS_RATE_DO_COST_FOLLOWUP_20261018.md): tarihli kaynak iddiası; bu oturumun ölçümü değildir.
- [SCALE_V2_S5_HOSTED_STAGING_ACCEPTANCE_20261019.md](../SCALE_V2_S5_HOSTED_STAGING_ACCEPTANCE_20261019.md): tarihli kaynak iddiası; bu oturumun ölçümü değildir.
- [SCALE_V2_S5_HTTP_CHUNK_ISOLATION_20261020.md](../SCALE_V2_S5_HTTP_CHUNK_ISOLATION_20261020.md): tarihli kaynak iddiası; bu oturumun ölçümü değildir.
- [SCALE_V2_S5_LOAD_COST_ACCEPTANCE_20261018.md](../SCALE_V2_S5_LOAD_COST_ACCEPTANCE_20261018.md): tarihli kaynak iddiası; bu oturumun ölçümü değildir.
- [SCALE_V2_S5_OWNER_SQLITE_LOCAL_BENCHMARK.md](../SCALE_V2_S5_OWNER_SQLITE_LOCAL_BENCHMARK.md): tarihli kaynak iddiası; bu oturumun ölçümü değildir.
- [SCALE_V2_S5_PROTECTED_FAIRNESS_THROUGHPUT_ACCEPTANCE_20261018.md](../SCALE_V2_S5_PROTECTED_FAIRNESS_THROUGHPUT_ACCEPTANCE_20261018.md): tarihli kaynak iddiası; bu oturumun ölçümü değildir.
- [SCALE_V2_S5_REAL_LOCAL_STREAM_LOAD_20261020.md](../SCALE_V2_S5_REAL_LOCAL_STREAM_LOAD_20261020.md): tarihli kaynak iddiası; bu oturumun ölçümü değildir.
- [s5-http-4mib-loopback-20261020.json](../reports/s5-http-4mib-loopback-20261020.json): mevcut kayıt; bu çalışma yeniden ölçmedi veya değiştirmedi.
- [s5-local-synthetic-20261018.json](../reports/s5-local-synthetic-20261018.json): mevcut kayıt; bu çalışma yeniden ölçmedi veya değiştirmedi.
- [s5-reconnect-loopback-20261018.json](../reports/s5-reconnect-loopback-20261018.json): mevcut kayıt; bu çalışma yeniden ölçmedi veya değiştirmedi.
- [s5-staging-readiness-20261019.json](../reports/s5-staging-readiness-20261019.json): mevcut kayıt; bu çalışma yeniden ölçmedi veya değiştirmedi.
- [s5-stream-loopback-20261020.json](../reports/s5-stream-loopback-20261020.json): mevcut kayıt; bu çalışma yeniden ölçmedi veya değiştirmedi.

Yeni raporlayıcı ham örnek şeması kullanır; eski aggregate p99 değerlerinden yeniden p99 üretmez. Eski kayıtlara otomatik uyarlayıcı eklenmedi. Ölçülmüş socket, reservation ve native completion ayrı kavramlardır. 100/1.000/10.000 varsayımsal nüfus kapasite sonucu değildir.

## Yeni S5-02 / S5-03 araçlarının kullanımı

Bunlar mevcut runner yerine geçmez; kendi başına yük üretmez, ağ açmaz. Yalnız kullanıcı tarafından seçilen yerel JSON dosyasını okur ve stdout'a yazar. Çıktı saklanacaksa yalnız `docs/delegated/output/` veya temp altında yönlendirin. Girdi içine credential veya gerçek kişi/cihaz kimliği koymayın.

```sh
node --import tsx scripts/delegated/s5-report-from-json.ts /tmp/samples.json md
node --import tsx scripts/delegated/s5-report-from-json.ts /tmp/samples.json csv
node --import tsx scripts/delegated/s5-cost-matrix.ts /tmp/cost-input.json
node --test --import tsx test/delegated/s5-report-from-json.test.ts test/delegated/s5-cost-matrix.test.ts
```

S5-02 örnek şeması (sentetik, üretim kabulü değildir):

```json
{"schema":"delegated-s5-samples-v1","kind":"synthetic","startedAtUtc":"2026-10-31T00:00:00Z","endedAtUtc":"2026-10-31T00:01:00Z","environment":"offline fixture","unit":"ms","samples":[{"ok":true,"latency":4},{"ok":false,"latency":null}]}
```

p50/95/99 nearest-rank yöntemidir; hata latencies dahil tüm bilinen gözlemler kullanılır. Null latency dışarıda kalır, outcome sayısı korunur. 100'den az latency örneğinde uyarı verir; 100 örnek bile kuyruk istatistiği güven aralığı değildir. Aggregate percentile değerleri örnek gibi beslenmemelidir. Eski rapor şemaları açıkça reddedilir; ölçülmemiş kapasite UNKNOWN kalır.

S5-03 örnek şeması (fiyat yok; bütün bilinmeyenler açık null):

```json
{"currency":"UNKNOWN","asOf":"2026-10-31","source":"operator workload assumptions; no verified prices","period":"hypothetical day","workload":[{"share":1,"perUser":{"ingressRequests":null,"d1Reads":null,"d1Writes":null,"cpuMs":null,"relayGB":null}}],"prices":{"ingressRequests":null,"d1Reads":null,"d1Writes":null,"cpuMs":null,"relayGB":null}}
```

Gerçek manuel fiyat nesnesi `amount`, `per`, `source`, `verifiedOn` gerektirir. Kaynak ve tarih birer operatör beyanıdır; araç internetten doğrulamaz. CPU birimi ms, relay ondalık GB'dır. Workload share toplamı 1 olmalıdır; her perUser metrik belirtilen döneme aittir. 100/1.000/10.000 nüfus yalnız hipotetik çarpandır. Fiyat, allowance, fixed fee, tier, depolama, DO ve vergi bilinmeden toplam fatura çıkmaz. `knownSubtotal` yalnız bilinen brüt değişken bileşenleri toplar; fatura alt sınırı değildir. Eksik bileşende `modeledVariableTotal=UNKNOWN`; kapsam dışı giderlerden dolayı `total` her zaman UNKNOWN'dır. Testlerdeki TEST parası ve sentetik sayılar gerçek fiyat değildir.

## Bu teslimin doğrulama kaydı

- OS: Linux; Node v24.22.1; 31 Ekim 2026. Kaynak türü: yerel/sentetik.
- Yeni testler: rapor 10, maliyet 10; toplam 20. Mevcut benchmark runner çalıştırılmadı.
- Base main CI: 41082039175, 41078541065, 41078541128 — aynı base SHA için completed/success. Bunlar yeni dalın CI sonucu değildir.
- AGENTS.md: base main dosya envanterinde bulunmadı. Açık PR listesinin ilk 100 girdisinde S4/S5 başlıklı eşleşme bulunmadı; bu tüm açık işlerin yokluğu kanıtı değildir.
- Görevler #486/#487; güvenlik, provider settlement, fiziksel cihaz, gerçek D1, 24h soak ve kapasite kabulü test edilmedi.
- Ana ekip talepleri: hukuki/sağlayıcı onayları, eski billing grace ile katı aday semantik arasındaki karar, güncel doğrulanmış fiyat/meter girdisi, yetkili staging bütçesi ve SLO, eski aggregate raporlar için gerekirse ayrı ham örnek export sözleşmesi. Bu talepler MAIN_TEAM_REQUESTS.md'ye koordinatör tarafından aktarılmalı; bu yardımcı dosyaya yazmadı.

## İkinci tur — sınır girdileri incelemesi

Eski uygulama yeni 36 testin 7'sinde başarısız oldu; düzeltme sonrası bu 36 test geçti. Ardından iki CLI regresyon testi eklendi: geçersiz JSON veya semantik girdide exit 2, boş stdout ve hata mesajı beklenir. Yalnız yerel/sentetik veri kullanılır.

Düzeltmeler: sample içinde birim override reddedilir; maliyet fiyatında açık `currency` kök para birimiyle, `unit` ise ilgili metrikle uyuşmalıdır. Workload ve fiyat nesnelerindeki tanımsız anahtarlar reddedilir. `currency=UNKNOWN` yalnız null fiyatlarla kullanılabilir. İmkânsız/kanonik olmayan ölçüm tarihleri reddedilir. CSV metinlerinde formül başlangıcına tek tırnak eklenir; virgül/çift tırnak/CRLF CSV kurallarıyla korunur. Bu nedenle formül benzeri metin CSV'de bilinçli olarak değişir.

Fiyat `unit` alanları: ingressRequests=`requests`, d1Reads/d1Writes=`rows`, cpuMs=`ms`, relayGB=`GB`. Alan yoksa kök currency ve metrik anahtarındaki birim kullanılır; otomatik döviz/birim dönüşümü yoktur. İstatistik nearest-rank; null süreler hariç, boşta UNKNOWN, tek örnekte üç percentile aynı değerdir. Negatif, NaN/Infinity ve taşma girdileri sayısal rapora dönüşmez. Eksik fiyat null ise UNKNOWN; fiyat alanı tamamen yoksa geçersiz şema hatasıdır. Açık doğrulanmış sıfır fiyat geçerlidir.

Sınırlamalar: operatör yanlış etiketli sayıyı doğru birim diye bildirirse araç bunu keşfedemez; kaynak/fiyat doğrulaması yapmaz. CSV savunması yaygın formül başlangıçlarını nötralize eder; tüm spreadsheet import seçenekleri test edilmedi. JavaScript kayan nokta hesabı muhasebe kesinliği sağlamaz. Yerel testler kapasite, provider veya üretim kabulü değildir.

## Üçüncü tur — bağımsız çevrimdışı sınır doğrulaması (31 Ekim 2026)

- Başlangıç exact HEAD `04c5f7d91f80a843d2f9655ccb5a58747e78de5e`: izinli alt süreç ortamında `node --test --import tsx test/delegated/s5-report-from-json.test.ts test/delegated/s5-cost-matrix.test.ts` **38/38 PASS, exit 0**. Kısıtlı sandbox ilk denemede iki CLI alt sürecini `EPERM` ile engelledi; bu kaynak hatası değildir.
- Bağımsız yeni karşı-örnekler: tanımsız fiyat metriği `prices.relayGiB` sessizce yok sayılarak tam modellenmiş değişken toplamı üretilebiliyordu; fiyat `source=UNKNOWN` iken sayı üretilebiliyordu; pozitif fiyat oranı, ağırlıklı kullanım veya çarpım IEEE-754 altında sıfıra taşarak sahte sıfır maliyet gösterebiliyordu. Biçimsel olarak üç harfli ama geçersiz `ZZZ` para birimi de kabul ediliyordu.
- Düzeltmeler yalnız `scripts/delegated/s5-cost-matrix.ts` ve `test/delegated/s5-cost-matrix.test.ts` kapsamındadır: bilinmeyen fiyat anahtarları, desteklenmeyen para birimi ve açık `UNKNOWN` fiyat kaynağı reddedilir; pozitif sayısal hesap sıfıra underflow ederse hata verilir. Altı yeni regresyon testi eklendi. Gerçek ve açıklanmış sıfır fiyat hâlâ geçerlidir; bilinmeyen fiyat null olarak `UNKNOWN` kalır. Para birimi ISO listesi çalışma zamanı `Intl` verisine bağlıdır; `TEST` ve `UNKNOWN` özel sentetik değerlerdir.
- Son doğrulama: **44/44 PASS, exit 0**; `npm run typecheck` exit 0; iki delegated araç için strict tsc exit 0; `git diff --check` exit 0. Sentetik hesap ve yerel test kanıtı dışında kapasite, fatura veya canlı servis sonucu yoktur.
- Başlangıç SHA için ana depodaki CI `41213280193` **completed/action_required** idi; yeni commit'e PASS aktarılmamalıdır. CI rerun ve deploy yapılmadı. Fiyat kaynağı operatör beyanı olarak kalır; döviz dönüşümü, muhasebe kesinliği, fixed fee/tax/tier/DO ve gerçek invoice hâlâ kapsam dışıdır.
