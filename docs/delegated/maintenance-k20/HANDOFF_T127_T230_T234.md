# K20 — P002 offline QA teslimi ve kabul sınırları

Tarih: **2026-11-01 (Europe/Istanbul)**. Kod tabanı:
`Naveax/Nexowire main` `93b6df33ef58610dcfdf3584bfe774e5afa7df4d`.
Yalnız `scripts/delegated/k20/**`, `test/delegated/k20/**` ve
`docs/delegated/maintenance-k20/**` değiştirildi. CORE, auth, Agent/Broker,
WAL, Cloudflare, billing, CI workflow ve canlı servis koduna dokunulmadı.

## T-127 — Web yardım bağlantıları

Çalıştırma: `node scripts/delegated/k20/help-link-audit.mjs --root .`

- `web/*.html` içinde yardım/rehber/bilgi, indirme ve SHA-256 etiketli
  **4** bağlantı bulundu (`web/connect.html`, satır 48, 49, 70, 71).
- Üç HTTPS dış link ve bir OAuth çalışma zamanı rotası **NOT_RUN**
  (varlık/auth/HTTP/TLS işlevi çevrimdışı doğrulanamaz). Yerel statik
  güvenlik biçimi bulgusu **0**.
- Güvensiz `javascript:`/HTTP, boş `href`, yeni sekmede `noopener` yokluğu,
  eksik yerel HTML hedefi/fragment ve dış symlink negatifleri test edildi.
- Bu test gerçek URL fetch, ChatGPT hesabı, browser, install veya pairing
  kabulünü **kanıtlamaz**.

## T-230 — Exact SHA ve gerçek CI job sayısı

`pr-evidence-gate.mjs --input snapshot.json` JSON'da 40 karakterlik `headSha`,
aynı `ci.headSha`, `runId`, `conclusion` ve benzersiz pozitif job `id`/
`conclusion` ister. CI boş-job `success` sonucu `UNKNOWN`, `action_required`
`BLOCKED`, farklı HEAD `STALE`, job hata/iptali `FAIL` olarak ayrılır.
Tüm job'lar başarılı görünse bile sonuç **REPORTED_SUCCESS_UNVERIFIED**
kalır: kullanıcı tarafından verilen JSON canlı GitHub CI delili değildir.
CI run/HEAD/job listesini doğrudan yetkili GitHub üzerinden tekrar doğrula.

## T-231 — Markdown symlink/anchor negatifleri

**ENGEL / NOT_RUN:** P001 [#1031](https://github.com/Naveax/Nexowire/pull/1031)
Draft kod dalındaki `check-doc-links.mjs` henüz upstream `main` üzerinde yok.
K20 bağımsız kod dalı upstream'den açıldığı için bu dosyayı ikinci kez
oluşturmak veya testini geçiyormuş gibi göstermek aynı-dosya çakışması üretir.
Bu turda yeni HTML yardım tarayıcısının symlink/fragment negatifleri çalıştı;
Markdown parser'ın ek negatifleri için #1031 merge/owner yönlendirmesi gerekir.

## T-232 — Sessiz test keşfi boşlukları

`test-discovery-audit.mjs .` → `POTENTIAL_GAP`, beklenen **exit 1**.
Mevcut `package.json` komutu `test/**/*.test.ts` uzantısını hedefliyor.
Bu bağımsız upstream tabanlı yeni dalda 461 test dosyası bulundu;
5 yeni `.test.mjs` dosyası TS-only kalıbında **listelenmiyor**.
Bu testlerin `node --test test/delegated/k20/*.test.mjs` ile ayrı çalışması
başka şeydir; `npm test`/CI çalıştırması **NOT_RUN**. Birleşmemiş #1031'in
diğer 6 `.mjs` dosyası da ilerde ayrı keşif ihtiyacı doğuracaktır.
K13 test runner sahibi bilgilendirilmeli; `package.json` bu dalda değiştirilmedi.

## T-233 — Yalnız ekip raporu PR'ı ayırma

`pr-diff-substance.mjs --input pr-files-snapshot.json` `TEAM_REPORT_ONLY`,
`DOCS_ONLY`, `TEST_ONLY`, `CODE_OR_MIXED`, `EMPTY_DIFF`, `UNKNOWN` ayrımını
korur. Dosya listesi tamamlanmadıysa `UNKNOWN`; dosya yolu geçersizse hata.
Sadece `ekip/**` değiştiren sentetik PR `TEAM_REPORT_ONLY` tespit edildi;
`docs/**` içeren PR **boş kod PR'ı diye etiketlenmedi**. Gerçek PR akışı
değiştirilmedi; hiçbir GitHub review, etiket veya merge yapılmadı.

## T-234 — Kullanıcı senaryosu risk eşlemesi

`scenario-risk-overlay.json` ve `scenario-risk-audit.mjs` P001 #1031
Draft'ta başlatılan `NC-001`–`NC-005` senaryolarını risk, negatif test ve
gerçek kabul deliline eşler. Bağlantı izni/hata dili, dar ekran odak,
admin durum anonsu, Windows kurulum yönlendirmesi, MCP/CORE yetki ayrımı.
Hepsi **NOT_RUN** gerçek kullanıcı/cihaz kabulü; sahte PASS veya tekrar eden
senaryo ID'si reddedilir. #1031'deki katalog merge edilmeden iki tablo
arasındaki bağ yalnız tasarım eşlemesidir.

## Test ve entegrasyon

`node --test --test-reporter=spec test/delegated/k20/*.test.mjs`:
**5/5 test dosyası PASS**; bunlar yerel/sentetik negatiflerdir.

Tam `npm test`, `npm run typecheck`, `npm run build`, Windows/gerçek tarayıcı,
OAuth hesabı, provider ve exact-head CI: **NOT_RUN**. PR Draft tutulmalı;
merge/release/owner onayı yoktur.
