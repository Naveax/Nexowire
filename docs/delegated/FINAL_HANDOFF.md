# FINAL_HANDOFF — dört destek PR'ının güncel kanıt ve teslim özeti

**REL-03 PARTIAL. Nihai kabul / sürüm hazır / üretim PASS ilan edilmez.** Bu belge dört ayrı Draft PR'ın aşağıdaki exact-SHA snapshot'larını kapsar; branch'ler birleştirilmedi. Kaynak/sentetik belge teslimi ile gerçek ürün kabulü birbirinden ayrılır.

## Snapshot ve sayım

İnceleme: **31 Ekim 2026, yaklaşık 18:55 Europe/Istanbul (15:55 UTC)**. #1000 ve #997 üçüncü tur, #998 ikinci tur commit'leri bu snapshot'ta **görüldü ve yeniden incelendi**. #999'un aşağıdaki SHA'sı bu güncelleme öncesi HEAD'dir; bu handoff düzenlemesinin SHA/CI sonucu commit'ten sonra ayrıca saptanır. İleride gelen yeni commit/test kanıtı otomatik geçerli sayılmaz.

Görev tanımı: `NEXOWIRE_ARKADAS_GOREVLERI_14_GUN(1).md`, belge v1.0, Library ID `libfile_cdb6b68f9a508191971ea411784e4b3b`, 284 satır tamamen yeniden okundu. Bölüm 4 görev başlıkları tek tek sayıldı: **26 benzersiz ID**. Bölüm 8'de belirtilen **26 görev** ile uyuşur; toplam uyuşmazlığı **YOK**. İç senaryo ID'leri (ör. S1-03-R01 veya provider vaka S4-01) üst seviye görev sayısına eklenmez.

| Grup | ID'ler (tek tek) | Adet |
|---|---|---:|
| K | K01, K02, K03 | 3 |
| S1 | S1-01, S1-02, S1-03 | 3 |
| S2 | S2-01, S2-02, S2-03 | 3 |
| S3 | S3-01, S3-02, S3-03, S3-04 | 4 |
| S4 | S4-01, S4-02 | 2 |
| S5 | S5-01, S5-02, S5-03, S5-04 | 4 |
| R | R-01, R-02, R-03, R-04 | 4 |
| REL | REL-01, REL-02, REL-03 | 3 |
| Toplam | 26 benzersiz görev | 26 |

## Tek PR listesi ve exact snapshot'lar

Ortak incelenen base main: `a19a228dc6f19fd484cf935e941a00ea625233f8`. 31 Ekim 2026 salt-okunur `git ls-remote` kontrolünde güncel upstream `main` de aynı SHA'daydı. Tümü fork `SinsiVinci/Nexowire-fork`, base `main`, open/Draft/unmerged. Bu gözlem ileri bir zamanda main'in değişmeyeceği garantisi değildir.

| Yardımcı / PR | Branch | İncelenen exact SHA | Dosya | Exact-head CI (API) |
|---|---|---|---:|---|
| 1 / [#1000](https://github.com/Naveax/Nexowire/pull/1000) | `docs/delegated-k-s1-20261031` | `478e5564e5c85e8973bf3c7b6e05cecb7c802085` | 7 | [41216541718](https://github.com/Naveax/Nexowire/actions/runs/41216541718) completed/action_required |
| 2 / [#998](https://github.com/Naveax/Nexowire/pull/998) | `docs/delegated-s2-s3-20261031` | `edc283fdbf9664225b71fa774cc95a91b2c0882b` | 8 | [41213214191](https://github.com/Naveax/Nexowire/actions/runs/41213214191) completed/action_required |
| 3 / [#997](https://github.com/Naveax/Nexowire/pull/997) | `docs/delegated-s4-s5-20261031` | `3bdd96f10168850d04e1a0b5483ea7378bb25ac7` | 8 | [41217302958](https://github.com/Naveax/Nexowire/actions/runs/41217302958) completed/action_required |
| 4 / [#999](https://github.com/Naveax/Nexowire/pull/999) | `docs/delegated-r-rel-20261031` | `abd377657dbc1647416191730f8130fe4a168837` | 8 | [41213416030](https://github.com/Naveax/Nexowire/actions/runs/41213416030) completed/action_required |

Tüm dört exact-head CI sonucu **action_required, PASS değil**; dört run için GitHub Actions API'de `jobs=[]` ayrıca doğrulandı. Önceki main yeşili veya önceki PR commit testleri bu HEAD'lere devredilmez. #999'un bu handoff değişikliğiyle oluşacak yeni SHA'sı ayrıca PR metadata/CI üzerinden doğrulanmalıdır; dosya kendi commit hash'ini önceden bilemez.

## Her görev için ayrı kanıt ve engel

Göreli yalnız dosya adları `docs/delegated/` altındadır; `scripts/` ve `test/` ile başlayanlar repo köküne göredir. Durum, **destek görevi çıktısının kabul düzeyini** belirtir; hiçbir satırda ürün/CORE/Windows/CI güvenlik kabulü verilmez. **PASS*** = yalnız izinli belge veya sentetik araç kapsamı geçti, fiziksel/üretim PASS değil; **PARTIAL** = çıktı var ama son inceleme/karar açık; **BLOCKED** = gerekli gerçek lab/CI kabulü yok; **NOT_STARTED** = çıktı yok. Her satırda CI ayrı sütundadır: **AR = completed/action_required, job PASS değil**. “İncelendi” içerik/statik incelemedir. Yardımcının raporlanan testi, bağımsız komut çalıştırılmasıyla karıştırılmaz. Planın yazılması testin çalıştırılması değildir.

| Durum | Görev adedi | Anlamı |
|---|---:|---|
| PASS* | 10 | Yalnız destek artefaktı/deterministik sentetik kapsam |
| PARTIAL | 12 | Belge/prototip mevcut; bağımsız veya karara bağlı kabul açık |
| BLOCKED | 4 | Windows, WAL, soak veya exact-head CI gerektiriyor |
| NOT_STARTED | 0 | 26 görevin hepsinin en az bir çıktısı mevcut |
| **Toplam** | **26** | Ürün ready/release kararı değildir |

| Görev | Durum | Çıktı | Kaynak PR / incelenen exact SHA | Yardımcının bildirdiği test | Bağımsız doğrulama | Exact-head CI | Kalan engel |
|---|---|---|---|---|---|---|---|
| K01 | PASS* | `00_BASELINE.md` | [#1000](https://github.com/Naveax/Nexowire/pull/1000) / `478e5564e5c85e8973bf3c7b6e05cecb7c802085` | Önceki kaynak/validate_docs.py 0 | Dosya eski snapshot'tan beri değişmedi; bu HEAD için PR/diff/CI tekrar okundu; typecheck 0 | [AR 41216541718](https://github.com/Naveax/Nexowire/actions/runs/41216541718) | Repo-geneli geçmiş kapsamı ve canlı cihaz durumu UNKNOWN |
| K02 | PASS* | `01_EXISTING_ASSETS.md` | [#1000](https://github.com/Naveax/Nexowire/pull/1000) / `478e5564e5c85e8973bf3c7b6e05cecb7c802085` | Önceki envanter doğrulaması 0 | İçerik eski snapshot'tan beri değişmedi; changed-file sınırı ve diff --check 0 | [AR 41216541718](https://github.com/Naveax/Nexowire/actions/runs/41216541718) | Mevcut bench/runner'lar bu tur çalıştırılmadı |
| K03 | PASS* | `02_EVIDENCE_TEMPLATE.md`; `MAIN_TEAM_REQUESTS.md` | [#1000](https://github.com/Naveax/Nexowire/pull/1000) / `478e5564e5c85e8973bf3c7b6e05cecb7c802085` | Önceki şablon/alan doğrulaması 0 | Yeni MAIN_TEAM_REQUESTS tam okundu: K-S1-REQ-01–14; yalnız bu dosya eski SHA'dan sonra değişti | [AR 41216541718](https://github.com/Naveax/Nexowire/actions/runs/41216541718) | 14 karar/kanıt talebi ana ekipte; kod/davranış kabulü değil |
| S1-01 | PASS* | `S1_CONNECTION_FLOW.md` | [#1000](https://github.com/Naveax/Nexowire/pull/1000) / `478e5564e5c85e8973bf3c7b6e05cecb7c802085` | Kaynak/doküman kontrolü 0 | İçerik önceki incelemeden sonra değişmedi; yeni SHA ile diff --check 0 | [AR 41216541718](https://github.com/Naveax/Nexowire/actions/runs/41216541718) | Mermaid gerçek render, NAT/CORE kabulü yok |
| S1-02 | PARTIAL | `S1_NETWORK_MATRIX.md` | [#1000](https://github.com/Naveax/Nexowire/pull/1000) / `478e5564e5c85e8973bf3c7b6e05cecb7c802085` | 13 ağ vaka planı; doğrulama 0 | 13 satır yeniden sayıldı; her vaka kaynak-only/UNKNOWN | [AR 41216541718](https://github.com/Naveax/Nexowire/actions/runs/41216541718) | NAT, proxy, TLS, IPv6, relay lab testleri NOT_RUN |
| S1-03 | PARTIAL | `S1_RECONNECT_CASES.md` | [#1000](https://github.com/Naveax/Nexowire/pull/1000) / `478e5564e5c85e8973bf3c7b6e05cecb7c802085` | 30 isimli vaka; doğrulama 0 | 30 benzersiz S1-03-R01–R30 yeniden sayıldı; no-replay beklentisi okundu | [AR 41216541718](https://github.com/Naveax/Nexowire/actions/runs/41216541718) | ACK/reconnect, iki cihaz, owner ve journal gerçek testleri NOT_RUN |
| S2-01 | PASS* | `S2_QUOTA_GLOSSARY.md` | [#998](https://github.com/Naveax/Nexowire/pull/998) / `edc283fdbf9664225b71fa774cc95a91b2c0882b` | Markdown/politika kontrolü ve build/typecheck 0 bildirildi | İçerik önceki incelemeden beri değişmedi; yeni HEAD typecheck 0 | [AR 41213214191](https://github.com/Naveax/Nexowire/actions/runs/41213214191) | Aylık mevcut model ile günlük öneri kararı ayrı; canlı kota yok |
| S2-02 | PASS* | `scripts/delegated/quota-examples.ts`; `test/delegated/quota-examples.test.ts` | [#998](https://github.com/Naveax/Nexowire/pull/998) / `edc283fdbf9664225b71fa774cc95a91b2c0882b` | 18/18 sentetik; build/typecheck 0 bildirildi | Yeni HEAD'de node --import tsx test dosyası: 18/18; typecheck 0 | [AR 41213214191](https://github.com/Naveax/Nexowire/actions/runs/41213214191) | Otoritatif quota/D1/çapraz dönem replay yok |
| S2-03 | PARTIAL | `prototypes/quota-preview.html` | [#998](https://github.com/Naveax/Nexowire/pull/998) / `edc283fdbf9664225b71fa774cc95a91b2c0882b` | Statik CSP/DEMO 0; Chromium browser denemesi 1 | HTML eski SHA'dan beri değişmedi; güncel browser engeli matrisi okundu | [AR 41213214191](https://github.com/Naveax/Nexowire/actions/runs/41213214191) | Render, 320/390/1280 px overflow, gerçek klavye görseli BLOCKED |
| S3-01 | PARTIAL | `S3_TWO_STEP_INSTALL.md` | [#998](https://github.com/Naveax/Nexowire/pull/998) / `edc283fdbf9664225b71fa774cc95a91b2c0882b` | Kaynak/pin kontrolü 0 bildirildi | İçerik önceki incelemeden beri değişmedi; v1.0.7 bootstrap vs v1.0.8 release ayrımı mevcut | [AR 41213214191](https://github.com/Naveax/Nexowire/actions/runs/41213214191) | Önerilen kanal ve imzalı installer/cihaz kabulü karar bekliyor |
| S3-02 | PARTIAL | `S3_TROUBLESHOOTING.md` | [#998](https://github.com/Naveax/Nexowire/pull/998) / `edc283fdbf9664225b71fa774cc95a91b2c0882b` | Kaynak/Markdown kontrolü 0 bildirildi | İçerik önceki incelemeden beri değişmedi; 401/403/409 ve güvenli tanı ayrımları mevcut | [AR 41213214191](https://github.com/Naveax/Nexowire/actions/runs/41213214191) | Repair/rollback/remove gerçek vaka doğrulaması NOT_RUN |
| S3-03 | PARTIAL | `prototypes/onboarding.html` | [#998](https://github.com/Naveax/Nexowire/pull/998) / `edc283fdbf9664225b71fa774cc95a91b2c0882b` | DOM-stub state/focus/retry 0; Chromium 1 bildirildi | HTML değişmedi; güncel gerçek Tab/label/outline prosedürü incelendi | [AR 41213214191](https://github.com/Naveax/Nexowire/actions/runs/41213214191) | Gerçek Tab, focus görünümü, screen reader, retry ve mobil render BLOCKED |
| S3-04 | BLOCKED | `S3_WINDOWS_ACCEPTANCE_MATRIX.md` | [#998](https://github.com/Naveax/Nexowire/pull/998) / `edc283fdbf9664225b71fa774cc95a91b2c0882b` | Windows vakaları NOT_RUN; kaynak/DOM-stub 0 | Bu SHA'daki yeni browser engel eki okundu; Windows matrisi 15 plan satırı | [AR 41213214191](https://github.com/Naveax/Nexowire/actions/runs/41213214191) | Disposable Win10/11, non-admin, Unicode, reboot/rollback, imzalı installer NOT_RUN |
| S4-01 | PARTIAL | `S4_PLAN_STATES.md` | [#997](https://github.com/Naveax/Nexowire/pull/997) / `3bdd96f10168850d04e1a0b5483ea7378bb25ac7` | Kaynak-only model incelemesi bildirildi | Doküman önceki snapshot'tan sonra değişmedi; yeni HEAD typecheck 0 | [AR 41217302958](https://github.com/Naveax/Nexowire/actions/runs/41217302958) | Legal/provider, pricing ve grace migration onayı yok; BILLING_PAUSED |
| S4-02 | PARTIAL | `S4_MOCK_PROVIDER_CASES.md` | [#997](https://github.com/Naveax/Nexowire/pull/997) / `3bdd96f10168850d04e1a0b5483ea7378bb25ac7` | 18 mock olay PLAN; NOT_RUN | 18 vaka ID'si yeniden sayıldı; dosya değişmedi | [AR 41217302958](https://github.com/Naveax/Nexowire/actions/runs/41217302958) | Provider signed webhook, checkout, refund/chargeback gerçek kabulü yok |
| S5-01 | PASS* | `S5_BENCHMARK_INDEX.md` | [#997](https://github.com/Naveax/Nexowire/pull/997) / `3bdd96f10168850d04e1a0b5483ea7378bb25ac7` | Runner envanteri; eski bench NOT_RUN | Yeni eklenen bağımlılık/yan etki sınırları okundu; diff --check 0 | [AR 41217302958](https://github.com/Naveax/Nexowire/actions/runs/41217302958) | Hiçbir bench/load runner çalıştırılmadı; gerçek ölçüm yok |
| S5-02 | PASS* | `scripts/delegated/s5-report-from-json.ts`; `test/delegated/s5-report-from-json.test.ts` | [#997](https://github.com/Naveax/Nexowire/pull/997) / `3bdd96f10168850d04e1a0b5483ea7378bb25ac7` | Yeni HEAD 44/44 birleşik S5 sentetik test, typecheck 0 bildirildi | Güncel HEAD'de 18/18 rapor testi; CLI alt süreç sandbox EPERM sonrası izinli izole tekrar 0; typecheck 0 | [AR 41217302958](https://github.com/Naveax/Nexowire/actions/runs/41217302958) | Gerçek ölçüm, p95 kapasite/soak veya raw-sample adapter kabulü yok |
| S5-03 | PASS* | `scripts/delegated/s5-cost-matrix.ts`; `test/delegated/s5-cost-matrix.test.ts` | [#997](https://github.com/Naveax/Nexowire/pull/997) / `3bdd96f10168850d04e1a0b5483ea7378bb25ac7` | Yeni HEAD birleşik 44/44, strict tsc 0 bildirildi | Güncel HEAD'de 26/26 maliyet testi; geçersiz CLI exit 2/stderr; typecheck 0 | [AR 41217302958](https://github.com/Naveax/Nexowire/actions/runs/41217302958) | Gerçek fiyat/metre/katalog yok; UNKNOWN invoice, dönüşüm yok |
| S5-04 | BLOCKED | `S5_FAILURE_AND_SOAK_PLAN.md` | [#997](https://github.com/Naveax/Nexowire/pull/997) / `3bdd96f10168850d04e1a0b5483ea7378bb25ac7` | 12 failure/soak vaka PLAN; NOT_RUN | 12 plan satırı ve izin/sentetik/staging ayrımı önceki incelemede görüldü; dosya değişmedi | [AR 41217302958](https://github.com/Naveax/Nexowire/actions/runs/41217302958) | 24 saat soak, foreground mouse, gerçek kapasite ve hard stop NOT_RUN |
| R-01 | BLOCKED | `R_WAL_REGRESSION_PLAN.md` | [#999](https://github.com/Naveax/Nexowire/pull/999) / `abd377657dbc1647416191730f8130fe4a168837` | WAL/SHM kaynak incelemesi; restart testi NOT_RUN | Bu HEAD'de dosya değişmedi; plan ve mevcut test referansları önceki incelemede kontrol edildi | [AR 41213416030](https://github.com/Naveax/Nexowire/actions/runs/41213416030) | Orphan/stale SHM, gerçek restart/DB, iki cihaz ve #974 kapanışı kanıtsız |
| R-02 | PARTIAL | `R_ERROR_DICTIONARY.md` | [#999](https://github.com/Naveax/Nexowire/pull/999) / `abd377657dbc1647416191730f8130fe4a168837` | 401/403/409 kaynak/handler incelemesi; runtime NOT_RUN | Bu HEAD'de dosya değişmedi; 409 SETUP_ALREADY_CONFIGURED ve ayrımlar önceki incelemede kontrol edildi | [AR 41213416030](https://github.com/Naveax/Nexowire/actions/runs/41213416030) | Tüm endpoint/postcondition ve canlı receipt/ACK doğrulanmadı |
| R-03 | PARTIAL | `R_ENVIRONMENT_DOCTOR_GUIDE.md` | [#999](https://github.com/Naveax/Nexowire/pull/999) / `abd377657dbc1647416191730f8130fe4a168837` | Doctor kaynak incelemesi; canlı probe NOT_RUN | Dosya değişmedi; disk/Agent online gibi desteklenmeyen yetenek sınırı önceki incelemede kontrol edildi | [AR 41213416030](https://github.com/Naveax/Nexowire/actions/runs/41213416030) | Gerçek Windows/WSL/VM/GPU/host Doctor probe yok |
| R-04 | PASS* | `scripts/delegated/redact-sample-log.ts`; `test/delegated/redact-sample-log.test.ts` | [#999](https://github.com/Naveax/Nexowire/pull/999) / `abd377657dbc1647416191730f8130fe4a168837` | 19/19 sentetik; build/typecheck/continuation 0 bildirildi | Bu HEAD'de 19/19 sentetik test ve typecheck 0; kaynak önceki SHA'dan beri değişmedi | [AR 41213416030](https://github.com/Naveax/Nexowire/actions/runs/41213416030) | Bilinmeyen örüntüler MANUAL_REVIEW_REQUIRED; gerçek log kabulü yok |
| REL-01 | PARTIAL | `REL_108_DRAFT_NOTES.md` | [#999](https://github.com/Naveax/Nexowire/pull/999) / `abd377657dbc1647416191730f8130fe4a168837` | Release API, #974/#980–984 source-only raporu | Bu HEAD'de dosya değişmedi; sürüm/release vs canary vs cihaz ayrımı önceki incelemede görüldü | [AR 41213416030](https://github.com/Naveax/Nexowire/actions/runs/41213416030) | İki cihaz, CORE enrollment, clean Windows, release readiness kararı yok |
| REL-02 | BLOCKED | `REL_TEST_AND_CI_MATRIX.md` | [#999](https://github.com/Naveax/Nexowire/pull/999) / `abd377657dbc1647416191730f8130fe4a168837` | İlk tur typecheck/build/continuation 0; tam npm test/check NOT_RUN | Dört güncel SHA için CI run ID/API action_required; kendi HEAD typecheck 0 | [AR 41213416030](https://github.com/Naveax/Nexowire/actions/runs/41213416030) | CI jobs yok; maintainer gate nedenini/işlerini onaylamadı |
| REL-03 | PARTIAL | `FINAL_HANDOFF.md` | [#999](https://github.com/Naveax/Nexowire/pull/999) / `abd377657dbc1647416191730f8130fe4a168837` | Önceki snapshot 57 sentetik/26 satır; kendi teslimi PARTIAL | Yeni dört HEAD, 26 görev, 81 sentetik test, dört diff-check, 14 talep uzlaştırıldı | [AR 41213416030](https://github.com/Naveax/Nexowire/actions/runs/41213416030) | Bu doküman yeni commit sonrası CI ve Köle 5/6 raporları; ana ekip final kabulü bekleniyor |

## Güncel exact-SHA bağımsız kontrol kaydı

Ortam: Linux / Node v24.22.1 / npm 11.9.0. Dört fork branch'i ayrı **detached** izole çalışma ağaçlarına alındı; kullanıcı cihazlarına, üretim tarayıcısına ve diğer yardımcıların gerçek branch'lerine müdahale edilmedi. Her biri için `npm ci --offline --ignore-scripts --no-audit --no-fund` exit 0; bunlar yalnız izole `node_modules` bağımlılıklarıdır. `main`/CORE/CI dosyaları değiştirilmedi. Denetim tarihi 31 Ekim 2026, Europe/Istanbul.

| Komut / işlem | Exact SHA | Bağımsız gözlenen sonuç |
|---|---|---|
| `node --import tsx test/delegated/quota-examples.test.ts` | #998 `edc283fdbf9664225b71fa774cc95a91b2c0882b` | **18/18 PASS**, fail/skip 0, exit 0 |
| `node --test --import tsx test/delegated/s5-report-from-json.test.ts test/delegated/s5-cost-matrix.test.ts` | #997 `3bdd96f10168850d04e1a0b5483ea7378bb25ac7` | **44/44 PASS**, fail/skip 0, exit 0, izinli izole test yürütmesi |
| `node --import tsx test/delegated/redact-sample-log.test.ts` | #999 `abd377657dbc1647416191730f8130fe4a168837` | **19/19 PASS**, fail/skip 0, exit 0 |
| `npm run typecheck` dört ayrı çalışma ağacında | #1000/#998/#997/#999 tabloda | **4/4 exit 0**; build/continuation bu tur tekrarlanmadı |
| `git diff a19a228... <HEAD> --check` | Dört güncel exact SHA | **4/4 exit 0**; izlenen dosya sayıları 7/8/8/8 |
| Eski→yeni commit dosya kıyası | #1000 b7704f1→478e556; #998 9d0560c→edc283f; #997 74e85ac→04c5f7d→3bdd96f | #1000 yalnız MAIN_TEAM_REQUESTS; #998 yalnız S3_WINDOWS_ACCEPTANCE_MATRIX; #997 önce iki hesaplayıcı/test ve indeks, sonra yalnız maliyet hesaplayıcı/test ve indeks değişti. Dolayısıyla eski SHA testleri yeni HEAD'e otomatik aktarılmadı |
| Vaka/çıktı kontrolü | İlgili güncel SHA | S1 ağ 13; reconnect benzersiz 30; S3 Windows plan 15; S4 mock 18; S5 failure/soak plan 12; 26 görev ID'si ve 31 ayrı PR çıktısı |
| CI commit-run API | Dört exact SHA | 41216541718 / 41213214191 / 41217302958 / 41213416030: **completed/action_required**, job PASS yok |

Toplam **81 sentetik test PASS** (18+44+19), **birleşik branch veya ürün testi değil**. İlk sandbox çalıştırmasında #997'nin iki CLI alt-süreç testi `spawnSync EPERM` nedeniyle 36/38'e düştü; doğrudan CLI `exit 2`/hata metni verdi. Aynı önceki exact SHA'da izinli, yalnız sentetik test ortamındaki tekrar **38/38 exit 0** ile sonuçlandı. İlk düşüş kod hatası olarak sınıflandırılmadı. Yeni `3bdd96f` HEAD'inde altı ek maliyet testiyle birlikte **44/44 exit 0** gözlendi; bilinmeyen fiyat anahtarı, kaynak `UNKNOWN`, geçersiz para birimi ve pozitif miktar/oran/ücret underflow reddi de bu kapsamda.

Önceki yardımcı PR açıklamalarındaki build, continuation ve geçici validate_docs.py sonuçları **raporlanan eski çalışmalardır**. #1000'deki yeni MAIN_TEAM_REQUESTS 14 talebiyle okundu; #998'in browser engeli eki ve #997'nin yeni testleri incelendi. CI exact-head kanıtı ayrı ve hâlâ engellidir.

## Açık kabul kapıları

- **CI:** dört exact snapshot action_required. Maintainer mevcut run/izin durumunu incelemeli; otomatik yeni PR run'ı varsa aynı SHA için dispatch/rerun yok. Bu çalışma CI ayarını değiştirmez.
- **Prototip:** #998'deki Chromium eksikliği raporu giderilmiş sayılmaz. Masaüstü/dar ekran taşma, Tab sırası, gerçek görünür odak, label/ekran okuyucu, hata/retry görsel kabulü **DOĞRULANMADI**. DOM stub ve kaynakta focus-visible bulunması gerçek klavye kabulü değildir. İkinci tur görsel commit snapshot'ta yok.
- **Windows/cihaz:** S3-04, S1 ağ/reconnect, WAL restart, S4 olay planları, S5 24h/foreground/kapasite testleri **NOT_RUN** olarak kalır. Atılabilir lab ve gerekli ayrı yetki sağlanmadan gerçek cihaz veya üretim çalıştırılmaz.
- **Kaynak/CI/release/cihaz ayrımı:** yayımlanmış v1.0.8 ve #974'teki geçmiş sınırlı canary kanıtı, dört destek PR'ının kabulü değildir. Bootstrap 1.0.7 / latest 1.0.8 kanalı, yayıncı imzası, clean Win10/11, ikinci cihaz, uyku/kesinti/24h ve CORE production kabulleri ayrı açık kapılardır.
- **Redaction:** yalnız sentetik API. Caller'ın synthetic işaretlemesi gerçek provenance garantisi değil; unknown/encoded/custom formatlar MANUAL_REVIEW_REQUIRED. Gerçek log işlenmedi.

## Ana ekibin vermesi gereken kararlar (uygulanmadı)

Tekilleştirilmiş 14 talebin ana kaydı **yalnız Köle 1'e ait** `docs/delegated/MAIN_TEAM_REQUESTS.md` / #1000 `478e5564e5c85e8973bf3c7b6e05cecb7c802085` üzerindedir. Bu dosyaya yazılmadı. Aşağıdaki gruplar, ilgili kararı ve beklenen kanıtı özetler:

| ID / kaynak | Ana ekip kararı | Gerekli kabul kanıtı |
|---|---|---|
| REQ-01–02 / #1000 | Exact-device trusted journal retrieval owner'ı; mutation no-replay / sınırlı read-only resume kanonik ayrımı | Yanlış owner/device, lost ACK ve fingerprint negatifleri; sıfır mutation redispatch; kaynak/test SHA |
| REQ-03 / #1000 + #998 | v1.0.7 bootstrap ile yayımlanmış v1.0.8 dağıtım/installer kanalı | Tag→payload/hash→imza zinciri ve disposable Windows sonucu |
| REQ-04 / #1000 + #997 | Ayrı ağ QA ve S5 staging owner'ları, bütçe, SLO, abort/izin | NAT/proxy/TLS ve ayrı yük/soak metrikleri, exact cihaz/ortam readback'i |
| REQ-05 / #998 + #997 | Günlük logical-vs-weighted kota ve legacy grace migration için **iki ayrı** versiyonlu karar | Mevcut aylık Free-only ayrımı; hesap/case negatifleri ve rollback sözleşmesi |
| REQ-06–08 / #997 | Legal/provider/catalog/settlement; doğrulanmış fiyat/meter; koşullu raw-sample export sözleşmesi | Tarihli onay, doğrulanmış fiyat birimi/kuru ve gerçek kaynak girdisi; UNKNOWN saklanmalı |
| REQ-09–11 / #998 | Browser/erişilebilirlik lab'ı, disposable Windows QA ve desteklenen repair/rollback/remove | 1280/390/320 px render, Tab/outline/label/retry; Win10/11 paket hash'i ve gözlemler |
| REQ-12 / #999 | WAL orphan/stale SHM kapsamı, #974 ve açık #986/#989 değerlendirmesi | Sentetik disposable DB/WAL/SHM negatifleri ve yetkili restart readback'i |
| REQ-13 / dört PR | Exact-head `action_required` CI nedenini maintainer incelemesi | Güncel her SHA için gerçek CI job çalışma ve tamamlanma kanıtı |
| REQ-14 / #999 | REL-03 bütünleşik inceleme, 26 ID ve ikinci tur SHA uzlaştırması | Bu handoff, Köle 5/6 kaynak raporları, çatışma/entegrasyon kontrolü ve ana ekip imzası |

### Köle 5 ve Köle 6 için beklenen kanıt

- **Köle 5:** Birleşik entegrasyon denetimi; incelenen exact dört SHA, changed-file çakışma haritası, birlikte derleme/çalıştırma yönteminin komutu/exit kodu ve kalan entegrasyon engelleri. Rapor henüz Onur tarafından iletilmedi; **DOĞRULANMADI**.
- **Köle 6:** CI/güvenlik engel raporu; her run'ın exact SHA/job durumu, `action_required` kök nedeni için kaynak, güvenlik bulgularının kesinlik seviyesi ve yetkili owner/karar. Rapor henüz iletilmedi; **DOĞRULANMADI**.
- Her iki rapor geldiğinde kaynak PR/SHA/komut/OS/tarih ile ayrı doğrulayıp bu dosyanın yeni sürümüne ekle. Gelen metin tek başına bir CI, CORE, cihaz veya release PASS kanıtı değildir.

## Teslim kararı ve ŞEF'e sınırlar

Dört Draft PR'da **31 ayrı dosya** var (7+8+8+8); **26 görev** sayısı dosya sayısı değildir. Durum: **10 PASS* (yalnız izinli destek çıktısı), 12 PARTIAL, 4 BLOCKED, 0 NOT_STARTED**. S2-03/S3-03 gerçek görsel ve klavye kabulü, S3-04 Windows, R-01 WAL restart, S5-04 24 saat soak, REL-02 CI ve REL-03 nihai karar **açık**. CORE, iki cihaz, güvenlik, ödeme, imzalı installer ve üretim yetkisi hiç doğrulanmadı.

**ŞEF kesinlikle yapmasın:** Bu dört PR'ı bu belgeye bakarak merge etmesin; Draft statüsünü kaldırıp release/tag/deploy başlatmasın; `action_required` CI'ı PASS diye işaretlemesin veya bizim adımıza rerun/dispatch yapmasın. Sahte/tarihsel canary'yi bugün iki-cihaz kabulü saymasın. Canlı Windows/Naveax/work-pc, Agent/Hub/Broker, CORE/enrollment, WAL onarma, gerçek OAuth/billing veya production üzerinde yetkisiz deneme yapmasın. Yalnız ana ekibin ayrıca yetkilendirdiği lab/CI kararlarıyla sonraki aşamaya geçilsin.

Bu turda değiştirilmesi gereken **tek repo dosyası** `docs/delegated/FINAL_HANDOFF.md` idi. Köle 1'in MAIN_TEAM_REQUESTS.md dosyası, diğer yardımcı kodları/dosyaları, CI workflow, CORE, Broker, auth, payment, cihaz, main ve release değişmedi. CI dispatch/rerun, merge/tag/deploy yapılmadı. İkinci tur snapshot entegrasyon kanıtıdır, **nihai ürün kabulü değildir**.
