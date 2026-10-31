# K03 — Birleştirilmiş ana ekip karar ve kabul talepleri

> Üçüncü tur kaynak kontrolü · 31 Ekim 2026 · Europe/Istanbul.
> Yalnız PR #1000 dalı: `docs/delegated-k-s1-20261031`; bu düzenleme öncesi HEAD `1123ef1133e24cb758a5bbbcace704c4891d823c`.
> Güncel ana dal `main`: `a19a228dc6f19fd484cf935e941a00ea625233f8` (GitHub main→#1000 compare); tüm PR'lar bu tabanı kullanıyor. Bu dosyanın sonraki commit SHA'sı GitHub PR HEAD'inden okunmalıdır.

Kullanıcının ikinci tur talimatıyla #998, #997 ve #999 açıklamalarındaki talepler, yardımcı 1'in dört mevcut talebiyle birleştirildi. K-S1-REQ-01–04 kimlikleri korundu; kurulum sürüm talebi REQ-03, ağ/staging ölçüm talebi REQ-04 altında tekilleştirildi. Gelecek kota sayım sözleşmesi ile legacy grace geçişi aynı REQ-05 içinde iki ayrı karar olarak korundu. CI talepleri REQ-13 altında toplandı.

Bu bir karar/kanıt bekleme listesidir; kod düzeltmesi, test yürütme veya üretim onayı değildir. Üçüncü turda dört PR'ın güncel metadata/açıklamaları, değişen dosya listeleri, seçili görev belgeleri ve ana dalın mutation/reconnect kaynakları salt-okunur incelendi. Diğer yardımcıların test komutları bu tur bağımsız yürütülmedi; PR bildirimi kesin hata demek değildir. 284 satırlık v1.0 görev dosyası tamamen okundu: K01–K03/S1–S5/R/REL toplam 26 üst seviye görev. “Engellenen görev” teslim edilmiş planın yazımını geri almaz; eksik son kabul aşamasını belirtir.

**Öncelik:** P0 = mutation güvenliği veya exact-head kabul kapısı; P1 = ayrı ekip kararı/QA gerektiren teslim kapısı; P2 = koşullu entegrasyon. Bu sıralama doğrulanmış bug şiddeti değildir. “Karar sahibi” isim değil sorumlu roldür; ana ekip atamasına kadar kişi bazında OWNER_UNASSIGNED. Ayrı yüzeyler için tek talep altında iki owner yazıldıysa ikisi de kendi kabul kanıtını üretmelidir.

## Okunan kaynak açıklamalarının fotoğrafı

| Kaynak PR | Okunan exact HEAD | Bildirilen kapsam / sınır |
| --- | --- | --- |
| [#1000](https://github.com/Naveax/Nexowire/pull/1000) | 1123ef1133e24cb758a5bbbcace704c4891d823c | K+S1; iki önceki commit ve 7 izinli Markdown dosyası. Bu düzenlemeden önceki HEAD. |
| [#998](https://github.com/Naveax/Nexowire/pull/998) | edc283fdbf9664225b71fa774cc95a91b2c0882b | S2/S3; ikinci turda Windows kabul matrisine browser engeli eklendi. 18/18 kota testi bildirildi; Playwright Chromium indirme/başlatma başarısız, görsel/gerçek klavye PARTIAL/BLOCKED. |
| [#997](https://github.com/Naveax/Nexowire/pull/997) | 04c5f7d91f80a843d2f9655ccb5a58747e78de5e | S4/S5; ikinci tur negatif girdi, birim/para birimi, tarih ve CSV düzeltmeleri; 38/38 sentetik test bildirildi. Gerçek fiyat/meter, ödeme/staging/soak yok. |
| [#999](https://github.com/Naveax/Nexowire/pull/999) | abd377657dbc1647416191730f8130fe4a168837 | R/REL; FINAL_HANDOFF 26 görevi eski snapshot'lara göre saydı. REL-03 PARTIAL, güncel diğer HEAD'lerin kabulü otomatik güncellenmedi. |

## Exact-head CI kanıtı

| PR | İncelenen SHA | Otomatik pull_request CI | İşler / kabul |
| --- | --- | --- | --- |
| #1000 | `1123ef1133e24cb758a5bbbcace704c4891d823c` | [41213287487](https://github.com/Naveax/Nexowire/actions/runs/41213287487) completed/action_required | jobs=[]; PASS değil |
| #998 | `edc283fdbf9664225b71fa774cc95a91b2c0882b` | [41213214191](https://github.com/Naveax/Nexowire/actions/runs/41213214191) completed/action_required | jobs=[]; PASS değil |
| #997 | `04c5f7d91f80a843d2f9655ccb5a58747e78de5e` | [41213280193](https://github.com/Naveax/Nexowire/actions/runs/41213280193) completed/action_required | jobs=[]; PASS değil |
| #999 | `abd377657dbc1647416191730f8130fe4a168837` | [41213416030](https://github.com/Naveax/Nexowire/actions/runs/41213416030) completed/action_required | jobs=[]; PASS değil |

Bu dört sonuç GitHub commit-run ve job listesi üzerinden salt-okunur doğrulandı. Bu doküman commit'i daha sonra yeni SHA/CI üretebilir; önceki çalışmanın sonucu yeni HEAD'e aktarılmaz. action_required'ın kök nedeni hâlâ UNKNOWN; tahmin edilen fork approval mekanizması kesin teşhis değildir. Manual rerun/dispatch yapılmadı.

## Talepler

### K-S1-REQ-01 — Güvenilir exact-device journal retrieval

- **Öncelik:** P0.
- **Karar sahibi:** Ana ekip MCP/authorization + exact-device journal entegrasyon owner'ı (atanacak).
- **Kaynak PR:** [#1000](https://github.com/Naveax/Nexowire/pull/1000), ilk tur kaynak incelemesi; issue #483.
- **İlgili dosya:** src/operations/agent-connection-journal-reconciliation.ts (reconcileConnectionBoundAgentOperation); çağıran product/MCP endpoint'i henüz bu talepte belirlenmedi.
- **Gereken karar:** Ana ekip trusted authenticatedDeviceId sağlayan yetkili salt-okunur retrieval kompozisyonunun owner'ını ve entegrasyon sınırını belirlesin. Helper'ın canlı retrieval yapmaması tek başına güvenlik hatası olarak sunulmuyor.
- **Kabul kanıtı:** Main `a19a228...` `reconcileConnectionBoundAgentOperation` kaynakta trusted `authenticatedDeviceId` + Hub provenance ve ayrı Hub/Agent fingerprint sözleşmesini denetliyor; canlı journal retrieval yapmıyor. Yetkili entegrasyonda yanlış owner/device, alias değişimi, eksik provenance, farklı fingerprint, offline/ACK kaybı negatifleri; Hub UNKNOWN, `automaticallyRetryable=false`, `externalSideEffectProven=false` ve sıfır mutation redispatch exact-SHA test/readback'i gerekir.
- **Engellenen görev:** S1-03'ün uçtan uca yetkili journal uzlaştırma kabulü; plan belgesi tamam.
- **Durum:** PROPOSED_NOT_IMPLEMENTED; entegrasyon ve fiziksel sonuç UNKNOWN.

### K-S1-REQ-02 — Canonical reconnect açıklamasını uzlaştırma

- **Öncelik:** P0.
- **Karar sahibi:** Ana ekip kanonik dokümantasyon owner'ı, Broker davranış owner'ıyla birlikte (atanacak).
- **Kaynak PR:** [#1000](https://github.com/Naveax/Nexowire/pull/1000), ilk tur kaynak incelemesi; issue #483.
- **İlgili dosya:** HANDOFF.md, docs/CONTINUATION.md; davranış kaynağı src/core/agent-broker.ts:resumePending ve test/native-session-continuity.test.ts.
- **Gereken karar:** Doküman owner'ı same-process continuity anlatımında mutation no-replay ile sınırlı read-only resume ayrımını açıklaştırsın. Burada canonical dosyalara yazılmadı.
- **Kabul kanıtı:** Main `a19a228...` `src/core/agent-broker.ts:resumePending` kaynakta aynı instance mutation için `MUTATION_STATE_UNKNOWN`, yeni instance için `AGENT_INSTANCE_CHANGED` döndürüyor ve replay etmiyor; read-only ise aynı requestId, capability ve bounded budget ile ayrı. `test/native-session-continuity.test.ts` negatifleri kaynakta var; bu tur çalıştırılmadı. Canonical belgelerin bu farkı açık anlatması ve sonraki exact-SHA test/CI kanıtı gerekiyor.
- **Engellenen görev:** K02/S1-01 canonical teslim açıklığının son incelemesi; runtime hatası tespiti veya uygulanmış düzeltme değil.
- **Durum:** DOCUMENTATION_REVIEW_REQUIRED.

### K-S1-REQ-03 — v1.0.7 bootstrap / v1.0.8 yayın kanal kararı

- **Öncelik:** P1.
- **Karar sahibi:** Installer/release/onboarding owner'ı (atanacak).
- **Kaynak PR:** [#1000](https://github.com/Naveax/Nexowire/pull/1000) + [#998](https://github.com/Naveax/Nexowire/pull/998); issue #485/#974. Tekrarlanan sürüm/öneri talebi bu satırda toplandı.
- **İlgili dosya:** installers/README.md, README.md, docs/INSTALL_WINDOWS.md, web/connect.js; yardımcı çıktısı docs/delegated/S3_TWO_STEP_INSTALL.md.
- **Gereken karar:** Installer/onboarding owner'ı hangi kanalı önerdiğini ve bootstrap/payload pinlerinin release ile ilişkisini belirlesin. Sürüm farkı doğrulanması gereken kanal farkıdır; tek başına bozuk kurulum veya güvenlik hatası değildir. Otomatik pin güncellemesi yapılmadı.
- **Kabul kanıtı:** Sunulan URL→tag→kaynak SHA→hash→payload sürüm zinciri; corrupt-download reddi, Unicode clean-profile test sonucu; yayıncı imzası ayrıca kanıtlanmalı.
- **Engellenen görev:** S3-01/S3-02'nin güncel önerilen dağıtım kanalına göre son incelemesi ve S3-04 kurulum kabulü.
- **Durum:** DECISION_REQUIRED; gerçek kurulum bu tur NOT_RUN.

### K-S1-REQ-04 — Yetkili ağ/staging bütçesi, SLO ve ölçüm

- **Öncelik:** P1.
- **Karar sahibi:** Koordinatör atamasıyla ağ QA owner'ı (S1) **ve ayrı** S5 performans/finans ölçüm owner'ı; tek izin iki bağımsız kabulü otomatik kapsamaz.
- **Kaynak PR:** [#1000](https://github.com/Naveax/Nexowire/pull/1000) + [#997](https://github.com/Naveax/Nexowire/pull/997); issue #483/#487. Ağ lab kanıtı ile staging budget/SLO talebi ortak owner/izin kapısında birleştirildi.
- **İlgili dosya:** docs/delegated/S1_NETWORK_MATRIX.md, docs/delegated/S1_RECONNECT_CASES.md, docs/delegated/S5_FAILURE_AND_SOAK_PLAN.md; metrik sınırı docs/SCALE_V2_S1_METRICS.md.
- **Gereken karar:** Koordinatör QA owner'ı, ayrı atılabilir lab/staging ortamı, hedef iş yükü, bütçe/hard-stop, süre/SLO eşikleri ve abort kriterlerini belirlesin; canlı test yetkisi bu belgeyle verilmez.
- **Kabul kanıtı:** Exact SHA+OS+izinli ortamda NAT/proxy/TLS/DNS/relay satırları, iki hedefin ayrı readback'i, sıfır mutation replay; S5 için örnek hacmi/p50/p95/p99, 24h gerçek süre gerekiyorsa elapsed kayıt, provider sayaçları ve limit gözlemi. Process-local byte/counter cloud faturası değildir.
- **Engellenen görev:** S1-02/S1-03 fiziksel ağ kabulü; S5-01/S5-04 staging/load/soak kabulü. Mevcut plan/indeks çıktıları tamamlanmış olabilir.
- **Durum:** AUTHORIZATION_AND_EVIDENCE_REQUIRED; fiziksel kapasite ve SLO UNKNOWN.

### K-S1-REQ-05 — Gelecek kota sayımı ve legacy grace geçiş sözleşmesi

- **Öncelik:** P1.
- **Karar sahibi:** Ürün/policy owner'ı ve billing migration owner'ı (atanacak); günlük kota ile legacy grace için iki ayrı imzalı karar.
- **Kaynak PR:** [#998](https://github.com/Naveax/Nexowire/pull/998) + [#997](https://github.com/Naveax/Nexowire/pull/997).
- **İlgili dosya:** docs/delegated/S2_QUOTA_GLOSSARY.md, scripts/delegated/quota-examples.ts, docs/delegated/S4_PLAN_STATES.md; mevcut politika docs/FREE_ONLY_POLICY.md.
- **Gereken karar:** Ürün/policy owner'ı (a) önerilen günlük logical-count ile 1x/5x weighted-budget ilişkisinin otoritatif sözleşmesini, (b) mevcut legacy grace davranışı ile daha katı öneri arasındaki geçişi ayrı ayrı belirlesin. PR açıklamaları bu ayrıntıların canlı uygulandığını veya mevcut kodun hatalı olduğunu kanıtlamaz.
- **Kabul kanıtı:** Versiyonlu karar metni; aylık mevcut/günlük öneri ayrımı; ordinary/skill, duplicate logical ID, UTC dönem sınırı, upgrade/downgrade ve grace örneklerinin beklenen kararları; ayrıca yetkili uygulama PR'ında exact-SHA negatifleri ve geçiş/rollback planı.
- **Engellenen görev:** S2-01/S2-02 örneklerinin gelecekteki otoritatif politikaya bağlanması ve S4-01/S4-02 entitlement/grace kabulü; offline örnek araç tamamlanması ayrı.
- **Durum:** POLICY_DECISION_REQUIRED; billing ve gelecekteki günlük model etkinleştirilmez.

### K-S1-REQ-06 — Legal/provider ve gerçek katalog/settlement kanıtı

- **Öncelik:** P1.
- **Karar sahibi:** Ticari/legal owner ile ödeme provider/settlement owner'ı (atanacak).
- **Kaynak PR:** [#997](https://github.com/Naveax/Nexowire/pull/997).
- **İlgili dosya:** docs/delegated/S4_PLAN_STATES.md, docs/delegated/S4_MOCK_PROVIDER_CASES.md.
- **Gereken karar:** Ana ekip ticari/legal ve provider onay owner'ını, geçerli katalog/plan eşlemesini ve ayrıca yetkilendirilecek gerçek ödeme kabul kapsamını belirlesin. Eksik onay bir runtime hata kanıtı değildir.
- **Kabul kanıtı:** Tarihli onaylar, doğrulanmış katalog/variant ilişkisi ve yetkili ortamda settlement/iptal/iade/chargeback readback'i; signed webhook güvenliği ayrı exact-SHA kanıtı. Gerçek para hareketi için ayrı yetki gerekir.
- **Engellenen görev:** S4-01/S4-02'nin gerçek sağlayıcı/ticari kabul aşaması; mock planların yazımı değil.
- **Durum:** APPROVAL_AND_EVIDENCE_PENDING; BILLING_PAUSED korunur.

### K-S1-REQ-07 — Doğrulanmış fiyat ve meter girdileri

- **Öncelik:** P1.
- **Karar sahibi:** S5 ölçüm owner'ı ve finans/fiyat doğrulama owner'ı (atanacak).
- **Kaynak PR:** [#997](https://github.com/Naveax/Nexowire/pull/997).
- **İlgili dosya:** scripts/delegated/s5-cost-matrix.ts, scripts/delegated/s5-report-from-json.ts; çıktı bağlamı docs/delegated/S5_BENCHMARK_INDEX.md.
- **Gereken karar:** Ölçüm/finans owner'ı hangi tarihli birim fiyatları, para birimini, provider meter export'unu ve iş yükü dağılımını kabul edeceğini belirlesin. Eksik alanlar UNKNOWN kalmalı.
- **Kabul kanıtı:** Kaynak/tarih/birim/para birimiyle fiyat girdileri; aynı ölçüm penceresine ait request, D1 IO, CPU-ms ve relay GB bağlamı; örnek hacmi ve gerçek-vs-hipotetik ayrımı. Hesaplanan senaryo gerçek fatura sayılmaz.
- **Engellenen görev:** S5-02/S5-03 gerçek ölçüm/maliyet raporu kabulü; saf offline hesaplayıcı testleri ayrı.
- **Durum:** INPUT_EVIDENCE_REQUIRED; #997'nin güncel sentetik 38/38 test raporu girdi doğrulama regresyonuna ilişkindir, gerçek fiyat/metre kanıtına değil.

### K-S1-REQ-08 — Aggregate raporlar için ham örnek export sözleşmesi

- **Öncelik:** P2.
- **Karar sahibi:** S5 rapor/ölçüm entegrasyon owner'ı (atanacak); adaptasyon yapılmayacaksa kararı kapatır.
- **Kaynak PR:** [#997](https://github.com/Naveax/Nexowire/pull/997).
- **İlgili dosya:** scripts/delegated/s5-report-from-json.ts; eski rapor ailesi scripts/report-s5-*.ts (kesin adapter hedef dosyası henüz seçilmedi).
- **Gereken karar:** Eski aggregate raporlar bu araca bağlanacaksa ölçüm owner'ı raw-sample schema/export sözleşmesini onaylasın; adaptasyon gerekmiyorsa bu talep kapsam dışı olarak kapatılabilir.
- **Kabul kanıtı:** Versiyonlu örnek girdisi, zaman/birim/ortam/hacim korunumu, eksik/geçersiz örnek negatifleri; aggregate yüzdeliklerden ham veri veya yeni p95 uydurulmaması.
- **Engellenen görev:** Yalnız S5-02'nin eski raporlarla entegrasyonu; bağımsız JSON rapor üreticisinin tamamlanması engellenmiyor.
- **Durum:** CONDITIONAL_DECISION_REQUIRED; uyumsuzluk kesin hata olarak doğrulanmadı.

### K-S1-REQ-09 — Gerçek browser görsel ve erişilebilirlik incelemesi

- **Öncelik:** P1.
- **Karar sahibi:** UI/erişilebilirlik QA owner'ı (atanacak).
- **Kaynak PR:** [#998](https://github.com/Naveax/Nexowire/pull/998).
- **İlgili dosya:** docs/delegated/prototypes/quota-preview.html, docs/delegated/prototypes/onboarding.html.
- **Gereken karar:** QA owner'ı yerel browser bulunan izole ortam ve görsel/erişilebilirlik inceleme kapsamını belirlesin. Güncel #998 açıklaması Chromium kurulumunda bozuk/kesik ZIP ve browser başlatma engeli bildiriyor; bu görevde gerçek browser deneyi yapılmadı.
- **Kabul kanıtı:** Aynı exact SHA'da viewport/mobile overflow, gerçek klavye/tab/focus/retry ve ekran okuyucu/label gözlemleri; statik DOM-stub sonucu gerçek browser kanıtının yerine geçmez.
- **Engellenen görev:** S2-03/S3-03 görsel ve gerçek klavye/erişilebilirlik incelemesi; PARTIAL/BLOCKED olarak bildirilmiş.
- **Durum:** PR_REPORTED_ENVIRONMENT_BLOCKER; #998 en son matrisinde görsel/gerçek Tab/viewport hâlâ BLOCKED. UI hatası da PASS da kanıtlanmış sayılmaz.

### K-S1-REQ-10 — Ayrı izinli disposable Windows QA

- **Öncelik:** P1.
- **Karar sahibi:** Windows installer QA/lab owner'ı (atanacak).
- **Kaynak PR:** [#998](https://github.com/Naveax/Nexowire/pull/998).
- **İlgili dosya:** docs/delegated/S3_WINDOWS_ACCEPTANCE_MATRIX.md, docs/delegated/S3_TWO_STEP_INSTALL.md.
- **Gereken karar:** Windows QA owner'ı atılabilir Windows 10/11 x64 ortamı, installer exact sürümü ve ayrıca yetkili yürütme kapsamını belirlesin; gerçek kullanıcı cihazı varsayılmaz.
- **Kabul kanıtı:** İlk kurulum/update/repair/cancel/rollback/reboot/relogin/Unicode/non-admin/düşük disk/proxy/checksum/kaldırma satırları için exact SHA, paket hash'i, OS ve gözlenen sonuç; NOT_RUN satırları PASS'a çevrilmez.
- **Engellenen görev:** S3-04 fiziksel/Windows installer kabulü; matris planı tamamlanması ayrı.
- **Durum:** AUTHORIZED_LAB_REQUIRED; gerçek Windows kurulumu bu tur NOT_RUN.

### K-S1-REQ-11 — Desteklenen repair/rollback/removal yönergeleri

- **Öncelik:** P1.
- **Karar sahibi:** Installer destek ve release contract owner'ı (atanacak).
- **Kaynak PR:** [#998](https://github.com/Naveax/Nexowire/pull/998).
- **İlgili dosya:** docs/delegated/S3_TROUBLESHOOTING.md, docs/delegated/S3_TWO_STEP_INSTALL.md; canonical docs/INSTALL_WINDOWS.md.
- **Gereken karar:** Installer/support owner'ı hangi recovery/repair/rollback/removal yollarının sürüm bazında gerçekten desteklendiğini doğrulasın. Bu talep komutların mevcut olduğunu veya hatalı olduğunu iddia etmez.
- **Kabul kanıtı:** Kaynak implementasyon+exact release eşlemesi, izole Windows test/readback'i; journal/kimlik/credential korunumu ve başarısız rollback durumunun açık raporu. Recovery komutu uydurulmaz.
- **Engellenen görev:** S3-01/S3-02 kurtarma yönergelerinin doğrulanmış son sürümü ve ilgili S3-04 satırları.
- **Durum:** SUPPORT_CONTRACT_REVIEW_REQUIRED.

### K-S1-REQ-12 — WAL orphan/stale SHM kapsamı ve kalan #974 kapıları

- **Öncelik:** P1.
- **Karar sahibi:** WAL güvenilirlik/QA owner'ı ve release kabul owner'ı (atanacak).
- **Kaynak PR:** [#999](https://github.com/Naveax/Nexowire/pull/999); açıklamada #974/#986/#989 takibi isteniyor.
- **İlgili dosya:** docs/delegated/R_WAL_REGRESSION_PLAN.md, docs/delegated/REL_108_DRAFT_NOTES.md; kapsam inceleme hedefleri test/agent-operation-wal-integrity.test.ts ve test/agent-journal-restart-regression.test.ts.
- **Gereken karar:** WAL/QA owner'ı orphan/stale SHM vakalarının mevcut testlerdeki gerçek kapsamını, açık #986/#989 işlerinin ilişkisini ve #974 kalan kabul kapılarını değerlendirsin. “Assess coverage” doğrulanmış eksik test veya bozuk validator demek değildir.
- **Kabul kanıtı:** Exact-SHA test/case eşlemesi; sentetik disposable DB/WAL/SHM negatifleri; UNKNOWN/ID korunumu; kalan physical gates için tarihli yetkili readback. Geçmiş #974 canary kanıtı yeni iki-cihaz/24h kabulü yerine geçmez.
- **Engellenen görev:** R-01 kapsam incelemesinin ve REL-01 sürüm/kalan kabul durumunun ana ekip onayı; belge/test planı tamamlanması ayrı.
- **Durum:** COVERAGE_UNKNOWN_PENDING_REVIEW; canlı WAL/SHM'ye müdahale yok.

### K-S1-REQ-13 — Fork exact-head CI action_required kapısı

- **Öncelik:** P0.
- **Karar sahibi:** GitHub repository maintainer / CI approvals owner'ı (atanacak).
- **Kaynak PR:** [#997](https://github.com/Naveax/Nexowire/pull/997), [#998](https://github.com/Naveax/Nexowire/pull/998), [#999](https://github.com/Naveax/Nexowire/pull/999), [#1000](https://github.com/Naveax/Nexowire/pull/1000).
- **İlgili dosya:** docs/delegated/REL_TEST_AND_CI_MATRIX.md, docs/delegated/FINAL_HANDOFF.md; GitHub Actions kabul durumu (workflow dosyasını değiştirme talebi değil).
- **Gereken karar:** Maintainer mevcut GitHub action_required durumunun nedenini ve gerekli onay adımını incelesin. Bu yardımcı CI onayı/dispatch/rerun yapmaz; test hatası veya yalnız “fork approval” nedeni kesinleştirilmedi.
- **Kabul kanıtı:** Yukarıdaki güncel SHA→run eşlemeleri doğrudan okundu: #997 41213280193, #998 41213214191, #999 41213416030, #1000 41213287487; hepsi completed/action_required ve jobs=[]. Önceki run'lar tarihsel, job PASS kanıtı değil. Maintainer gate gerekçesini ve yeni exact HEAD'de gerekli job'ların gerçekten çalışıp tamamlandığını kaydetmeli.
- **Engellenen görev:** Dört PR'ın CI kabulü; REL-02/REL-03 bütünleşik exact-head kanıt kapanışı. Yerel test/doküman sonuçları geçersiz kılınmış sayılmaz.
- **Durum:** CI_ACCEPTANCE_BLOCKED; incelenen dört HEAD'in action_required sonucu doğrulandı, kök neden UNKNOWN; bu dosyanın yeni commit'inin CI sonucu ayrıca okunmalı.

### K-S1-REQ-14 — Yardımcılar arası bağımsız inceleme ve REL-03 kapanışı

- **Öncelik:** P1.
- **Karar sahibi:** Delegation koordinatörü / REL-03 entegrasyon handoff owner'ı (atanacak).
- **Kaynak PR:** [#999](https://github.com/Naveax/Nexowire/pull/999); karşılaştırılacak teslimler [#1000](https://github.com/Naveax/Nexowire/pull/1000), [#998](https://github.com/Naveax/Nexowire/pull/998), [#997](https://github.com/Naveax/Nexowire/pull/997).
- **İlgili dosya:** docs/delegated/FINAL_HANDOFF.md; taleplerin tekilleştirme kaydı bu MAIN_TEAM_REQUESTS.md dosyası.
- **Gereken karar:** Koordinatör #999 FINAL_HANDOFF'un eski #1000 b7704f1 / #998 9d0560c / #997 74e85ac snapshot'ını güncel #1000 1123ef1 / #998 edc283f / #997 04c5f7d ile yeniden uzlaştırsın. #999 kendi güncel abd3776 HEAD'inin CI ve belge durumunu da kapsasın. 26 görevin bütünleşik kabulünü bağımsız kararlaştırsın; bu talep listesi tek başına son kabul değildir.
- **Kabul kanıtı:** 26 görev için doğru PASS/PARTIAL/BLOCKED/NOT_STARTED eşlemesi; exact branch/SHA/PR/CI bağları, izinli dosya kapsamı, gerçek çalıştırılan komutlar, ortak engeller ve fiziksel NOT_RUN ayrımı. İncelenmeyen alanlar DOĞRULANMADI kalır.
- **Engellenen görev:** REL-03 nihai bütünleşik handoff; #999 kendi kısmı PARTIAL olarak bildiriliyor.
- **Durum:** COORDINATOR_REVIEW_REQUIRED; #999 handoff içindeki 26 satır var ve ilk snapshot doğrulamasını raporluyor, fakat yeni #997/#998/#1000 commit'leri ile güncel test sayıları o handoff tablosunda henüz uzlaştırılmadı. FINAL_HANDOFF.md bu yardımcı tarafından değiştirilmedi.

## Değişiklik ve yetki sınırı

Bu turda yalnız kendi fork dalındaki docs/delegated/MAIN_TEAM_REQUESTS.md güncellenir. Diğer yardımcıların dalları/dosyaları, canonical belgeler, CORE/Broker/auth, ödeme, canlı servis ve ağ ayarları değişmez. Merge, CI dispatch veya rerun yapılmaz. Güncel runtime/cihaz durumu UNKNOWN; doğrulanmamış PR bildirimleri kesin hata olarak sunulmaz.
