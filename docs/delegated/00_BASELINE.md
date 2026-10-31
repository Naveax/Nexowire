# K01 — Güncel branch, PR ve CI fotoğrafı

> Yardımcı geliştirici 1 · 2026-10-31T17:34:18+03:00 · main a19a228dc6f19fd484cf935e941a00ea625233f8 · dal docs/delegated-k-s1-20261031.
> Yalnız kaynak/doküman incelemesi; canlı cihaz veya servis deneyi yapılmadı.

## Ayrı clone ve sınırlar

Yeni clone: nexowire-helper1. Başlangıç status: main...origin/main; diff boş. Kaynak main iki ls-remote okumasında aynı SHA. Origin Naveax/Nexowire.git; fork SinsiVinci/Nexowire-fork.git. Ayrı dal açıldı; remote aynı adlı dal sorgusu boştu. Mevcut çalışma ağacı resetlenmedi. Clone içinde AGENTS.md bulunmadı (rg --files --hidden -g AGENTS.md -g !.git).

Linux 6.18.57 x86_64; Node v24.22.1; npm 11.9.0; Git 2.51.1. gh kurulu değil; bağlı GitHub API okundu. Canlı cihaz, CORE, Broker, auth, ödeme, üretim veya ağ ayarı değiştirilmedi.

## Kanıt sınıfları

| Sınıf | Anlam |
| --- | --- |
| source-only | Dosya/implementasyon görüldü; çalışma/dağıtım kanıtı değil. |
| test-only | Exact SHA ve runner için sonuç; fiziksel kabul değil. |
| merged | GitHub merged=true ve merge commit; closed tek başına yetmez. |
| released | Yayın kaydı, tag ve SHA; kurulu sürüm anlamına gelmez. |
| deployed | Belirli hedef/sürüm/zamanda yetkili dağıtım readback'i gerekir. |
| physical-verified | Belirli cihazda yetkili deney ve bağımsız readback; geçmiş tarihe özgüdür. |
| UNKNOWN | Kanıt yok/yetersiz; PASS veya FAIL değildir. |

## İlgili PR ve exact-head CI

| PR | Durum ve base | Exact HEAD | Workflow | Kanıt sınıfı |
| --- | --- | --- | --- | --- |
| [#980](https://github.com/Naveax/Nexowire/pull/980) | open, draft=True, merged=False; main | 7e4093c30c1ead3cd22888184450c34aef4737da | [Release Readiness 41113730994](https://github.com/Naveax/Nexowire/actions/runs/41113730994) completed/success; [CI 41113730982](https://github.com/Naveax/Nexowire/actions/runs/41113730982) completed/success | source-only; test-only; deployed/physical UNKNOWN |
| [#981](https://github.com/Naveax/Nexowire/pull/981) | open, draft=True, merged=False; integration/core-after-v108-20261030 | b4d6e57053cce6738087e8cecf932fab3492f3c3 | [CI 41120875406](https://github.com/Naveax/Nexowire/actions/runs/41120875406) completed/success | source-only; test-only; deployed/physical UNKNOWN |
| [#982](https://github.com/Naveax/Nexowire/pull/982) | open, draft=True, merged=False; core/bounded-native-verifier-host-20261030 | 5e52b756cc6959ffacb7bcd25f2fc1ad2beccc39 | [CI 41139860087](https://github.com/Naveax/Nexowire/actions/runs/41139860087) completed/success | source-only; test-only; deployed/physical UNKNOWN |
| [#983](https://github.com/Naveax/Nexowire/pull/983) | open, draft=True, merged=False; core/native-verifier-mtls-client-20261031 | 21ae78aabf074db67c7bf46d20911a9d09f5b891 | [CI 41142754565](https://github.com/Naveax/Nexowire/actions/runs/41142754565) completed/success | source-only; test-only; deployed/physical UNKNOWN |
| [#984](https://github.com/Naveax/Nexowire/pull/984) | open, draft=True, merged=False; local/persistent-enrollment-design-20261031 | 9d0f35607d4cde87bd031e2da77855cfaf570c31 | [CI 41145160595](https://github.com/Naveax/Nexowire/actions/runs/41145160595) completed/success | source-only; test-only; deployed/physical UNKNOWN |
| [#986](https://github.com/Naveax/Nexowire/pull/986) | open, draft=True, merged=False; main | 0f6e35e5abbd0bfee006e0757f7477c2f69b2834 | [CI 41199721229](https://github.com/Naveax/Nexowire/actions/runs/41199721229) completed/success | source-only; test-only; deployed/physical UNKNOWN |
| [#954](https://github.com/Naveax/Nexowire/pull/954) | closed, draft=True, merged=True; main | 77781e4eee89e343bd7d988b35a720f6e20a4439 | UNKNOWN: ayrıca sorgulanmadı | merged; test UNKNOWN; deployed/physical UNKNOWN |
| [#957](https://github.com/Naveax/Nexowire/pull/957) | closed, draft=True, merged=False; qa/11-journal-wal-recycle-20261029 | 88fa241df3c0c1721638bb2420918ae9fc3866bf | UNKNOWN: ayrıca sorgulanmadı | source-only; test UNKNOWN; deployed/physical UNKNOWN |

[#978](https://github.com/Naveax/Nexowire/pull/978): merged=true, merge commit 62c1edff0d80590433872ded6ee2b6f791688573; candidate de5813ab0c6eeebd081a4db1a2df42ee796f5186. #957 kapalı ama doğrudan merge edilmemiştir; entegre fix için #978 ve kaynak geçmişi esas alınır. #980–#984 stacked Draft zinciri; bu yardımcı bunlardan kod taşımadı, base yalnız main.

## Main CI / release

| Workflow | Exact SHA | Gözlenen | Sınıf |
| --- | --- | --- | --- |
| [Release Readiness 41082039175](https://github.com/Naveax/Nexowire/actions/runs/41082039175) | a19a228dc6f19fd484cf935e941a00ea625233f8 | completed/success | test-only; yayın ayrıca release API kaydıyla karşılaştırıldı |
| [CI 41078541065](https://github.com/Naveax/Nexowire/actions/runs/41078541065) | a19a228dc6f19fd484cf935e941a00ea625233f8 | completed/success | test-only; yayın ayrıca release API kaydıyla karşılaştırıldı |
| [Publish Authorized Release 41078541128](https://github.com/Naveax/Nexowire/actions/runs/41078541128) | a19a228dc6f19fd484cf935e941a00ea625233f8 | completed/success | test-only; yayın ayrıca release API kaydıyla karşılaştırıldı |

[v1.0.8 release API](https://api.github.com/repos/Naveax/Nexowire/releases/tags/v1.0.8): draft=false, prerelease=false, published_at=2026-10-30T15:55:53Z. Tag/SHA #974 ve main geçmişiyle tutarlı; sınıf released. Bu yardımcı asset indirme/hash kontrolü yapmadı. Combined status statuses=[] döndü: CI yok veya PASS demek değildir. Actions doğrudan GET ile ayrıca okundu; PR workflow aracı yalnız PR-event ilk sayfayı getirir.

## Scale issue durumu

| Issue | API durumu | Son güncelleme UTC | Kanıt sınırı |
| --- | --- | --- | --- |
| [#482](https://github.com/Naveax/Nexowire/issues/482) | open | 2026-10-21T13:03:18Z | Takip kaydı; tek başına fiziksel kabul değil. |
| [#483](https://github.com/Naveax/Nexowire/issues/483) | closed | 2026-10-18T00:32:17Z | Kapalı olmak bütün bağlantı/NAT kabulünü kanıtlamaz. |
| [#484](https://github.com/Naveax/Nexowire/issues/484) | open | 2026-10-20T20:28:23Z | Takip kaydı; tek başına fiziksel kabul değil. |
| [#485](https://github.com/Naveax/Nexowire/issues/485) | open | 2026-10-23T10:25:21Z | Takip kaydı; tek başına fiziksel kabul değil. |
| [#486](https://github.com/Naveax/Nexowire/issues/486) | open | 2026-10-20T20:28:25Z | Takip kaydı; tek başına fiziksel kabul değil. |
| [#487](https://github.com/Naveax/Nexowire/issues/487) | open | 2026-10-18T00:36:21Z | Takip kaydı; tek başına fiziksel kabul değil. |
| [#974](https://github.com/Naveax/Nexowire/issues/974) | open | 2026-10-30T15:56:36Z | Takip kaydı; tek başına fiziksel kabul değil. |

#974 son ekinde 2026-10-30 yetkili NAVEAX 1.0.8 canary, iki Agent restart, iki Windows reboot, 1.703 orijinal operasyon/UNKNOWN korunumu ve Broker readback kanıtı var: tarihsel reported deployed/physical-verified, tek hedef. Bu yardımcı yeniden çalıştırmadı; bugün iki cihazın sürümü/online durumu UNKNOWN. Clean Windows, interruption/sleep, 24 saat/iki cihaz kabulü tamamlanmış sayılmıyor. CORE üretim NO-GO; S6 kapsam dışı.

## Açık iş / çakışma sınırı

Açık PR araması topn=100 sınırına ulaştı: tam depo sayımı değildir. Ayrıca updated-desc REST ilk 30 PR okundu. Aşağıdaki ek PR'ların kodu/CI'ı bu yardımcı tarafından kabul edilmedi.

| PR | Başlık | Sınıf |
| --- | --- | --- |
| [#987](https://github.com/Naveax/Nexowire/pull/987) | [AI-04] Fail closed on mutable Broker OS scope witnesses | open Draft; source-only; CI/deployed/physical UNKNOWN |
| [#990](https://github.com/Naveax/Nexowire/pull/990) | [AI-07] Fail-closed OS sandbox policy and native self-diagnostics | open Draft; source-only; CI/deployed/physical UNKNOWN |
| [#989](https://github.com/Naveax/Nexowire/pull/989) | [AI-08] Independent adversarial QA: WAL, CAS, receipt, enrollment, TLS pin and sandbox | open Draft; source-only; CI/deployed/physical UNKNOWN |
| [#993](https://github.com/Naveax/Nexowire/pull/993) | [AI-02] Harden persistent enrollment IPC, identity preflight and safe removal | open Draft; source-only; CI/deployed/physical UNKNOWN |
| [#995](https://github.com/Naveax/Nexowire/pull/995) | [Coordinator] Non-destructive v1.0.8 stacked PR merge-tree rehearsal | open Draft; source-only; CI/deployed/physical UNKNOWN |
| [#994](https://github.com/Naveax/Nexowire/pull/994) | [Coordinator] v1.0.8 exact-SHA integration gates and CORE NO-GO ledger | open Draft; source-only; CI/deployed/physical UNKNOWN |
| [#985](https://github.com/Naveax/Nexowire/pull/985) | [AI-06] Extend terminal CORE claim readiness and session-race regressions | open Draft; source-only; CI/deployed/physical UNKNOWN |
| [#996](https://github.com/Naveax/Nexowire/pull/996) | [Coordinator P0] Gate CORE completion on durable native-verified claim ledger | open Draft; source-only; CI/deployed/physical UNKNOWN |
| [#992](https://github.com/Naveax/Nexowire/pull/992) | [AI-05] Freeze authenticated CAS identity across SQL and external reserve | open Draft; source-only; CI/deployed/physical UNKNOWN |
| [#986](https://github.com/Naveax/Nexowire/pull/986) | [AI-01] Harden WAL/SHM preflight against late path and header races | open Draft; source-only; CI/deployed/physical UNKNOWN |
| [#988](https://github.com/Naveax/Nexowire/pull/988) | [AI-03] Harden mTLS verifier response validation and regression coverage | open Draft; source-only; CI/deployed/physical UNKNOWN |
| [#991](https://github.com/Naveax/Nexowire/pull/991) | feat(quota): give SinsiVinci unmetered hosted MCP credits via immutable GitHub ID | open Draft; source-only; CI/deployed/physical UNKNOWN |

Yedi hedef dosya main'de yoktu. Diğer PR'ların bütün changed-file sayfaları taranmadı: depo genelinde çakışmasızlık UNKNOWN. Koordinatör güncel main ve ortak MAIN_TEAM_REQUESTS sahipliğini birleştirmeden önce tekrar kontrol etmeli. CI dispatch/rerun yapılmadı.

## Yerel doğrulama

Yalnız Markdown: izinli yedi dosya, referans varlığı, belge alanları, >=20 senaryo, ağ matrisi ve git diff --check kontrolü. npm ci/typecheck/build/continuation:check veya runtime testleri çalıştırılmadı. Bunların sonucu NOT_RUN; bu belge paketinin kabulü fiziksel bağlantı kabulü değildir. Commit sonrası exact HEAD/PR/CI nihai rapor ve PR açıklamasına yazılır; dosyanın kendi commit SHA'sı kendi içine eklenmez.

Doğrulama gözlemi (2026-10-31, Europe/Istanbul): geçici yerel validate_docs.py kontrolü exit 0; 7/7 sahipli dosya, 30 benzersiz reconnect senaryosu, 13 ağ satırı, kaynak referanslarının varlığı ve zorunlu kanıt alanları PASS (documentation/local). git diff --cached --check exit 0. Yeni test/runner repo içine eklenmedi. Staged diff: 7 yeni Markdown dosyası; runtime veya konfigürasyon değişikliği yok.
