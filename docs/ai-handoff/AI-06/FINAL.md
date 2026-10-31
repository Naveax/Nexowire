# AI-06 teslimi

- **Karar:** `READY_FOR_REVIEW` (kaynak + sentetik negatif regresyon) / **Production CORE `NO_GO`**.
- **Branch:** `ai/06-console-claim`.
- **Draft PR:** https://github.com/Naveax/Nexowire/pull/985
- **İlk test HEAD SHA:** `f958e4136a4e1378c2279efe9e29436bf3adbcf2`.
- **Base SHA:** `7e4093c30c1ead3cd22888184450c34aef4737da` (#980; #951 düzeltmesini içerir).
- **Değişen izinli dosyalar:** `src/product/d1-core-console-authority.ts`, `test/ai06-consent-claim-races.test.ts`, `docs/ai-handoff/AI-06/STATUS.md`, `CONTRACT.md`, `INTEGRATION_REQUEST.md`, `TEST_EVIDENCE.md`, `FINAL.md`. Mevcut testlerin negatif beklentileri silinmedi veya gevşetilmedi.
- **CI run ID:** https://github.com/Naveax/Nexowire/actions/runs/41194595574; exact ilk HEAD; ilk gözlemde Node 22/24 ve macOS/WSL2/Linux/security PASS; Windows browser-live henüz sürüyor. Ek dokümantasyon commit'i yeni HEAD oluşturursa o SHA'nın CI kanıtı ayrıdır.
- **Negatif test sonuçları:** İlk 13 test Node 22 ve 24 CI'da **13/13 PASS**. D1 signing-key claim/status race + missing key ile toplam 16 test; son 3 testin exact source HEAD CI doğrulaması **henüz yok**. Hedef: post-await SPKI değişimini reddetmek ve missing-key status'ü fail-closed yapmak.
- **Komut/exit:** local `node --test --import tsx ...` ve `npm run typecheck` NOT_RUN (yerel repo/dependency ortamı yok); CI job SUCCESS. OS/sürüm ve sayılar TEST_EVIDENCE.md'de.
- **Mock / real OS:** sentetik `node:sqlite` + fixture signing; gerçek protected Win32 native authority/approval, OS-effect sınırı, iki-PC fiziksel kabul yapılmadı.
- **AI-02/03 interface:** `CONTRACT.md` ve `INTEGRATION_REQUEST.md`. Session PID/creation, interactive desktop/owner SID/LUID ve effect-boundary monotonic revoke kontrolü ayrı korunmuş native API'den gerekli; Agent JS readback tek başına atomiklik kanıtı değildir.
- **Açık P0 / risk:** native final OS readback-to-effect TOCTOU, gerçek onaylayıcı origin/publisher, rollback-independent ledger, gerçek Windows console session switch/logout/restart/lock, signed binary ve unattended revoke acceptance yok. AI-03 transport/AI-02 enrollment entegrasyonu koordinatörde.

**Yasaklara uyum:** Ana dala push, merge, tag, release, canlı Agent/Hub/Broker, UAC/ACL/DPAPI, D1/Cloudflare, token veya sahte consent oluşturma yapılmadı. CORE aktifleştirilmedi. Draft PR bağımsız AI-08 incelemesine hazır; gerçek native/physical kabul olmadan production NO-GO.

**Ek inceleme:** #985 üzerinde D1 signing-key rotasyonu sonrası stale claim/status yetkisi saptandı; izinli D1 dosyasında fail-closed düzeltme ve 3 yeni negatif vaka eklendi. Son HEAD CI doğrulanana dek `READY_FOR_REVIEW` ilk 13 testin kanıtıdır, yeni düzeltme için `IN_PROGRESS`. Production NO-GO değişmez.

- **İlave provider düzeltmesi:** `WindowsCoreConsoleProvider.execute`
  için kuyruk/async öncesi derin JSON snapshot; `core-console-provider.integration.test.ts`
  içinde mutation-negatif testi. CI doğrulaması yeni HEAD'e aittir.
- **D1 ek P0:** Claim'in native readback onayı henüz gelmeden
  `complete(succeeded)` kabul edebilmesi riskinin çözümü mevcut
  SQL CHECK/operation migration sınırı dışında. Koordinatör ve AI-03'e
  `INTEGRATION_REQUEST.md` üzerinden native-verified claim marker
  talep edildi. Bu risk production NO-GO nedenidir.
