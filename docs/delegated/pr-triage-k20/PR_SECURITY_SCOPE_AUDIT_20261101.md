# PR açıklaması, etiket ve değişen dosya güvenlik-kapsam denetimi

**K20 / T-129 · 2026-11-01 (Europe/Istanbul) · salt-okunur örneklem.**

Kaynak: [Naveax/Nexowire açık PR'ları](https://github.com/Naveax/Nexowire/pulls)
GitHub REST `pulls?state=open&per_page=100&page=1` ve her seçilen PR için
`pulls/{number}/files?per_page=100`. Toplam 11 PR örneklenmiştir; tüm açık
PR'lar veya merge edilebilirlik hakkında kapsamlı sonuç değildir. Aşağıdaki
dosya listeleri PR başına 100'den az olduğu için ilk dosya sayfası yeterliydi.
Örneklemde **11/11 PR Draft**, **11/11 etiket listesi boş**; etiket yokluğunun
güvenlik açısından herhangi bir olumlu anlamı yoktur.

## PR bazlı kanıt ve karar

| PR ve exact HEAD (2026-11-01) | Başlık/açıklama ve etiket gözlemi | Değişen dosya kanıtı | K20 sınıflaması |
| --- | --- | --- | --- |
| [#1031](https://github.com/Naveax/Nexowire/pull/1031) · `99a76109e69e73c5a835b8ac6e980ee1d2dcb8d5` | `test(qa)`, non-core/offline beyanı; etiket yok | 14 dosya, yalnız `docs/delegated/maintenance-k20/**`, `scripts/delegated/k20/**`, `test/delegated/k20/**` | **Non-core aday**; exact-head CI/owner incelemesi bekliyor |
| [#1029](https://github.com/Naveax/Nexowire/pull/1029) · `919da8e9a99eb827a0900eadd4a905c7423cae02` | `test(qa)`, offline maliyet ve UNKNOWN beyanı; etiket yok | 4 dosya: `src/ops/scale-s5-cost-envelope.ts`, `scripts/report-s5-cost-matrix.ts`, 2 test | **Koşullu inceleme**; kaynak model sınırları/billing aktivasyonu ayrılmalı |
| [#1026](https://github.com/Naveax/Nexowire/pull/1026) · `0876648a4e03288c619557cdc09512a6bc396c68` | `test(ui)`, cihaz state kontratı beyanı; etiket yok | 2 dosya: `docs/delegated/device-ux-k15/**`, `test/delegated/k15/**` | **Non-core aday**; gerçek cihaz/yetki kabulü değil |
| [#1018](https://github.com/Naveax/Nexowire/pull/1018) · `53667dfdcee664e4dea7acb28a49792e45e6da29` | `docs`, güvenli Windows/ChatGPT kurulum açıklaması; etiket yok | 3 dosya: `docs/CHATGPT_INSTALL_PROMPT.md`, `docs/INSTALL_WINDOWS.md`, `test/delegated/k06/**` | **Non-core aday**; yönlendirme metni canlı kurulum/onay kanıtı değil |
| [#1011](https://github.com/Naveax/Nexowire/pull/1011) · `ccbaaff7758769d096c8109e54d697762323f266` | `fix(ui)`, hata/yeniden deneme; etiket yok | 4 dosya: `web/connect.html`, `web/connect.js`, `test/delegated/k01/**` | **UI-adjacent koşullu**; eşleştirme yetkisi, istek parametreleri ve auth değişmezliği diff ile incelenmeli |
| [#1009](https://github.com/Naveax/Nexowire/pull/1009) · `8a9e7c814529b462c5d3b93728202a5ca0561c8d` | `[Coordinator P0]` WAL preflight/journal; etiket yok | 2 dosya, `src/agent/operation-journal.ts` dahil | **CORE engelli**; K20 kod sahibi olamaz |
| [#1007](https://github.com/Naveax/Nexowire/pull/1007) · `663e4c1ed0c6ba6b0c995843609f198a66d6ecb2` | `[Coordinator P0]` native claim/D1; etiket yok | 5 dosya, `cloudflare/migrations/0021_core_console_native_claim_verified.sql` + CORE claim testleri | **CORE engelli**; SQL claim güvenlik kapısı |
| [#1003](https://github.com/Naveax/Nexowire/pull/1003) · `30a905351c4bb91ad279e1f3532f8416c421ff67` | `Connection Core v2`, Cloudflare+Agent bağlantısı; etiket yok | 18 dosya; `.github/workflows/ci.yml`, `src/hub/control-plane-agent-auth.ts`, `src/mcp/local-first-cloudflare.ts` dahil | **CORE/CI engelli**; canlı ağ/credential/yetki sınırı |
| [#996](https://github.com/Naveax/Nexowire/pull/996) · `71286f47b11c6ba76ea59309c5a1aba4c3ea82dd` | `[Coordinator P0]` verified native claim; etiket yok | 3 dosya; CORE native claim SQL migrasyonu + test | **CORE engelli**; dış onay gerektirir |
| [#995](https://github.com/Naveax/Nexowire/pull/995) · `b7dc8f3333b36b82a04935bea761904eb85216e2` | `[Coordinator]` yalnız merge-tree rehearsal beyanı; etiket yok | 8 dosya, `.github/workflows/coord-v108-merge-rehearsal.yml`, `scripts/coord-v108-*` dahil | **CI/integrasyon kontrollü**; workflow izinleri ve gerçek kod çalıştırmama ayrı incelenmeli |
| [#997](https://github.com/Naveax/Nexowire/pull/997) · `3bdd96f10168850d04e1a0b5483ea7378bb25ac7` | `docs`, S4/S5 sentetik plan ve rapor beyanı; etiket yok | 8 dosya yalnız `docs/delegated/**`, `scripts/delegated/**`, `test/delegated/**` | **Non-core aday**; fatura/gerçek provider ve CI kanıtı değil |

**Sonuç:** 4 PR doğrudan non-core dosya adayı (#1031, #1026, #1018,
#997); 2 PR davranış/dosya içeriği koşullu inceleme (#1029, #1011); 4 PR
CORE veya CI/izin koruması nedeniyle K20 implementasyon yetkisinin dışında
(#1009, #1007, #1003, #996); 1 PR CI/integrasyon kontrollü (#995).
Bu, dosya adlarına ve açıklamalara dayanan **ön elemedir**, kod incelemesi,
koruma kuralı onayı, test veya merge kararı değildir.

## Negatif güvenlik sınıflandırma örnekleri

1. **Etiket boş → güvenli** çıkarımı yanlıştır. Bu örneklemde bütün etiketler
   boş olmasına rağmen 4 PR kritik CORE alanlarına dokunuyor.
2. **Açıklamada "no CORE" geçiyor → güvenli** çıkarımı yanlıştır. Böyle
   bir ifade gerçek changed-file ve diff kontrolünün yerini tutamaz.
3. **Sadece test içeriyor → otomatik güvenli** çıkarımı yanlıştır. Native claim,
   migration veya canlı credential/sandbox testleri güvenlik kapısını
   gevşetebilir; davranış ve fixture izin sınırları ayrıca incelenir.
4. **`ci`/`docs` başlıklı → uygulama dışı** çıkarımı yanlıştır. Workflow'da
   token `write`, `pull_request_target` veya secret kullanımı bağımsız risk;
   release/CORE belgelerinin değiştirilmesi canlı kabul değildir.
5. **Eski PR açıklamasındaki SHA → şimdiki HEAD** çıkarımı yanlıştır.
   İnceleme anında PR HEAD'i ve diff'i yeniden çekip aynı SHA'ya bağla;
   değiştiyse sonuç `UNKNOWN` olsun.

## Bir sonraki incelemeci için salt-okunur kontrol listesi

- [ ] PR'ın güncel tam HEAD/base SHA'sını ve Draft durumunu yeniden oku.
- [ ] Etiketleri **bilgi** say; yetki veya sahiplik kanıtı sayma.
- [ ] Tüm changed-file sayfalarını topla; CORE, `auth`, `security`, `journal`,
      migrations, `cloudflare/`, workflows, release ve secret dosyalarını
      ayrıca sınıflandır.
- [ ] Sadece yol değil, diff içeriğinde yetki genişletme, fail-open,
      token/secret, mutasyon tekrarı, gerçek servis başlatma ve test gevşetme
      olup olmadığını ilgili sahibiyle incele.
- [ ] CI'yı exact-HEAD çalışan job ve başarılı sonuçla kanıtla; `action_required`,
      `pending`, boş jobs veya sentetik PASS'i kabul sayma.
- [ ] Ömer'in CORE/cihaz/hesap sahipliğini ihlal etme; bu raporu otomatik
      merge/approve, release veya etiket güncellemesi için kullanma.

Gerçek cihaz/Windows/Cloudflare/provider ve exact-head GitHub CI kabulü:
**NOT_RUN**. Hiçbir PR'a etiket eklenmedi, review gönderilmedi ve branch/PR
değiştirilmedi.
